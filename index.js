// FitRPG Bot — All-in-One (Mobile-first, Themeable Hunts & Raids, Art on Loot/Equip)
// CommonJS + discord.js v14

const {
  Client, GatewayIntentBits,
  REST, Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const fs = require('fs');
const http = require('http');

/* ---------------- Health server for Render ---------------- */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('FitRPG bot is running.\n');
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

/* ---------------- ENV ---------------- */
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID; // Application (Client) ID
const guildId  = process.env.GUILD_ID;  // Server (Guild) ID
const LEVELUP_CHANNEL_ID = process.env.LEVELUP_CHANNEL_ID || null;
const DAILY_CHANNEL_ID   = process.env.DAILY_CHANNEL_ID   || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

/* ---------------- Persistence (Mongo optional) ---------------- */
const USE_MONGO = !!process.env.MONGO_URI;
let mongo = null;
async function initMongo(){
  if(!USE_MONGO) return;
  const { MongoClient } = require('mongodb');
  mongo = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 5 });
  await mongo.connect();
  console.log('✅ MongoDB connected');
}
const DATA_FILE = 'data.json';

let store = {
  users: {},
  shop: { items: [] },
  events: [],
  raids: {},     // channelId -> raid object
  hunts: {},     // channelId -> hunt object
  bounties: { dailyKey: null, daily: null },
  artMap: {},    // key -> image url (items/monsters/pets/mounts)
  _todayDaily: {}, // dateISO -> { theme, tasks }
  config: {
    timezoneNote: 'America/Chicago',
    levelUpChannelId: LEVELUP_CHANNEL_ID,
    dailyChannelId: DAILY_CHANNEL_ID,
    logCooldownSec: 10,
    adventureCooldownSec: 15,
    raidHitCooldownSec: 8,
    huntCooldownSec: 30,
    huntDurationMin: 60,
    dailyPost: { hour: 0, minute: 1, tz: 'America/Chicago' } // 00:01 CT
  }
};

function ensureUser(id){
  if(!store.users[id]) store.users[id] = {
    xp:0, coins:0, tokens:0,
    inventory:[],
    equipped:{weapon:null,armor:null,trinket:null,cosmetic:null, pet:null, mount:null},
    lastLog:0, lastAdventure:0, lastRaidHit:0, lastHunt:0,
    lastActiveISO:null, streak:0,
    dailyProgress:{},
    _buffs:{},
    bestiary:{}
  };
  return store.users[id];
}
function saveFile(){ fs.writeFileSync(DATA_FILE, JSON.stringify(store,null,2)); }

async function loadStore(){
  if (USE_MONGO){
    const col = mongo.db('fitrpg').collection('state');
    const doc = await col.findOne({ _id: 'GLOBAL' });
    if (doc && doc.data) store = { ...store, ...doc.data };
  } else {
    if (fs.existsSync(DATA_FILE)) {
      try { store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) }; }
      catch {}
    }
  }
}
async function saveStore(){
  if (USE_MONGO){
    const col = mongo.db('fitrpg').collection('state');
    await col.updateOne({ _id:'GLOBAL' }, { $set: { data: store, updatedAt: new Date() } }, { upsert: true });
  } else {
    saveFile();
  }
}
let saveTimer=null;
function saveSoon(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>saveStore().catch(console.error), 500); }

/* ---------------- Utils ---------------- */
function R(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function getNowInTZ(tz) { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); }

/* ---------------- XP / Level model (smooth to 1000) ---------------- */
function xpForLevel(level){
  if (level <= 1) return 100;
  const base = 60;
  return Math.floor(base * Math.pow(level, 1.15) + 40);
}
function totalXpForLevel(level){
  let t=0; for (let i=1;i<=level;i++) t += xpForLevel(i); return t;
}
function levelFromXp(xp){
  let lvl=0, need=0, acc=0;
  while (true){
    need = xpForLevel(lvl+1);
    if (acc + need > xp) break;
    acc += need; lvl++;
    if (lvl >= 1000) break;
  }
  return lvl;
}

/* ---------------- Exercises & XP rates ---------------- */
const BUILT_INS = {
  pushups:{ unit:'reps', rate:0.55 },
  situps:{ unit:'reps', rate:0.45 },
  squats:{ unit:'reps', rate:0.45 },
  pullups:{ unit:'reps', rate:2.2 },
  burpees:{ unit:'reps', rate:1.2 },
  dips:{ unit:'reps', rate:1.6 },
  plank:{ unit:'seconds', rate:0.22 },
  run_miles:{ unit:'miles', rate:40 },
  run:{ unit:'minutes', rate:0.35 },
  cycle_miles:{ unit:'miles', rate:14 },
  row_minutes:{ unit:'minutes', rate:0.45 },
  swim_laps:{ unit:'laps', rate:20 },
  bench:{ unit:'reps', rate:1.2 },
  legpress:{ unit:'reps', rate:1.2 },
  deadlift:{ unit:'reps', rate:1.4 },
  squat_barbell:{ unit:'reps', rate:1.4 },
  ohp:{ unit:'reps', rate:1.1 },
  strengthsession:{ unit:'sessions', rate:40 }
};

/* ---------------- Gear Tier Gates ---------------- */
function maxTierForLevel(lvl){
  if (lvl >= 900) return 10;
  if (lvl >= 750) return 9;
  if (lvl >= 600) return 8;
  if (lvl >= 450) return 7;
  if (lvl >= 325) return 6;
  if (lvl >= 225) return 5;
  if (lvl >= 150) return 4;
  if (lvl >= 90)  return 3;
  if (lvl >= 40)  return 2;
  return 1;
}
function filterGearByTier(items, lvl){
  const cap = maxTierForLevel(lvl);
  return items.filter(i => (i.type==='weapon'||i.type==='armor') && (i.tier||1) <= cap);
}

/* ---------------- Shop Items (T1—T10) ---------------- */
function buildShopItems(){
  const weapons = [
    { name:'Wooden Club',       type:'weapon', tier:1, atk:2,  price:120 },
    { name:'Bronze Dagger',     type:'weapon', tier:1, atk:3,  price:180 },
    { name:'Iron Sword',        type:'weapon', tier:2, atk:6,  price:420 },
    { name:'Steel Saber',       type:'weapon', tier:2, atk:8,  price:650 },
    { name:'Runed Blade',       type:'weapon', tier:3, atk:12, price:1200 },
    { name:'Sunforged Spear',   type:'weapon', tier:4, atk:18, price:2000 },
    { name:'Dragonbone Axe',    type:'weapon', tier:5, atk:26, price:3100 },
    { name:'Celestial Halberd', type:'weapon', tier:6, atk:35, price:4500 },
    { name:'Starpiercer Lance',   type:'weapon', tier:7, atk:46, price:6400 },
    { name:'Voidreaver Scythe',   type:'weapon', tier:8, atk:58, price:8800 },
    { name:'Aurora Greatsword',   type:'weapon', tier:9, atk:72, price:12000 },
    { name:'Transcendent Blade',  type:'weapon', tier:10, atk:90, price:16000 }
  ];
  const armors = [
    { name:'Padded Vest',        type:'armor', tier:1, def:2,  price:110 },
    { name:'Leather Coat',       type:'armor', tier:1, def:3,  price:170 },
    { name:'Chainmail',          type:'armor', tier:2, def:6,  price:420 },
    { name:'Scale Plate',        type:'armor', tier:2, def:8,  price:650 },
    { name:'Runed Aegis',        type:'armor', tier:3, def:12, price:1200 },
    { name:'Sunforged Plate',    type:'armor', tier:4, def:18, price:2000 },
    { name:'Dragonhide Mail',    type:'armor', tier:5, def:26, price:3100 },
    { name:'Celestial Carapace', type:'armor', tier:6, def:35, price:4500 },
    { name:'Aegis of Dawn',      type:'armor', tier:7, def:46, price:6300 },
    { name:'Eclipse Barrier',    type:'armor', tier:8, def:58, price:8700 },
    { name:'Mythril Bastion',    type:'armor', tier:9, def:72, price:11800 },
    { name:'Omega Bulwark',      type:'armor', tier:10, def:90, price:15800 }
  ];
  const trinkets = [
    { name:'Lucky Charm',         type:'trinket', tier:2,  bonus:'+2% coins',           price:800  },
    { name:'Runner’s Band',       type:'trinket', tier:2,  bonus:'+3% run XP',          price:1000 },
    { name:'Focus Bead',          type:'trinket', tier:3,  bonus:'+3% all XP',          price:1800 },
    { name:'Philosopher’s Sigil', type:'trinket', tier:5,  bonus:'+4% all XP',          price:3200 },
    { name:'King’s Crest',        type:'trinket', tier:6,  bonus:'+6% coins',           price:4200 },
    { name:'Eternal Compass',     type:'trinket', tier:7,  bonus:'+8% adventure loot',  price:5600 },
    { name:'Fateweaver Charm',    type:'trinket', tier:8,  bonus:'+10% hunt loot',      price:7200 },
    { name:'Celestial Relic',     type:'trinket', tier:9,  bonus:'+12% all XP',         price:9200 },
    { name:'Omniscient Eye',      type:'trinket', tier:10, bonus:'+14% all XP',         price:12000 }
  ];
  const consumables = [
    { name:'Health Potion', type:'consumable', effect:'Restore stamina (flavor)', price:100 },
    { name:'Energy Drink',  type:'consumable', effect:'+10% XP for next log',     price:160 },
    { name:'Treasure Map',  type:'consumable', effect:'Guarantee loot on /adventure', price:500 }
  ];
  const pets = [
    { name:'Pocket Slime', type:'pet', bonus:'+2% XP from logs', price:900,  tier:2 },
    { name:'Trail Hawk',   type:'pet', bonus:'+3% run XP',       price:1200, tier:3 }
  ];
  const mounts = [
    { name:'Sprint Goat',  type:'mount', bonus:'+5% hunt token chance', price:1500, tier:3 },
    { name:'Shadow Steed', type:'mount', bonus:'+5 Power in hunts',     price:2200, tier:4 }
  ];
  return [...weapons, ...armors, ...trinkets, ...consumables, ...pets, ...mounts];
}
store.shop.items = store.shop.items?.length ? store.shop.items : buildShopItems();

/* ---------------- ASCII Sprite library + art helper ---------------- */
const SPRITES = {
  goblin:
`  ,      ,
 /(.-""-.)\\
 |\\  \\/  /|
 | \\_/\\_/ |
 \\  /  \\  /
  \\/    \\/`,
  wolf:
`  /\\   /\\
 //\\\\_//\\\\
 \\_     _/
  / * * \\
  \\_^_^_/`,
  ogre:
`   _____
  /     \\
 |  0 0  |
 |   ^   |
 |  '-'  |
  \\_____/
  _|_|_|_`,
  pocket_slime:
`   __
 _(  )_
(  oo  )
 \\_.._/`,
  trail_hawk:
`  __
{_  \\_
  \\  __)
  / /`,
  sprint_goat:
`  __  _
 (  \\/ )
  \\__/\\
  /\\  \\
 (_/  /_)`,
  shadow_steed:
`   /\\
  //\\\\
 /_  _\\
  /\\/\\
  \\__/`,
  // Gear minis (fallbacks)
  starpiercer_lance:
`   /\\
  /  \\
  |  |
  |  |
  |  |
  \\__/`,
  voidreaver_scythe:
`   __
  /  \\
 | () |
  \\__/
   ||
  /__\\`,
  aurora_greatsword:
`   /\\
  /  \\
 | || |
 | || |
  \\__/`,
  transcendent_blade:
`   /\\
  /++\\
 |++++|
 |++++|
  \\__/`,
  aegis_of_dawn:
`  .----.
 /      \\
|  ()    |
 \\      /
  '----'`,
  eclipse_barrier:
`  .----.
 / **** \\
| *    * |
 \\ **** /
  '----'`,
  mythril_bastion:
`  .----.
 / ==== \\
| |====| |
 \\ ==== /
  '----'`,
  omega_bulwark:
`  .----.
 / OOOO \\
| O    O |
 \\ OOOO /
  '----'`
};
function spriteBlockOrImage(key) {
  const artUrl = store.artMap?.[key.toLowerCase()] || store.artMap?.[key] || null;
  if (artUrl) return { image: artUrl, text: null };
  const k = key.replace(/\s+/g,'_').toLowerCase();
  const ascii = SPRITES[key] || SPRITES[k] || null;
  return ascii ? { image: null, text: '```\n' + ascii + '\n```' } : { image: null, text: null };
}

/* ---------------- Exercise Themes + targets ---------------- */
const EXERCISE_THEMES = {
  pushups:      { label:'Pushups',      unit:'reps',   key:'pushups' },
  squats:       { label:'Bodyweight Squats', unit:'reps', key:'squats' },
  situps:       { label:'Sit-ups',      unit:'reps',   key:'situps' },
  pullups:      { label:'Pull-ups',     unit:'reps',   key:'pullups' },
  burpees:      { label:'Burpees',      unit:'reps',   key:'burpees' },
  plank_seconds:{ label:'Plank (seconds)', unit:'seconds', key:'plank' },
  run_miles:    { label:'Run Distance', unit:'miles',  key:'run_miles' }
};
function targetFor(mode, exercise){
  const m = (mode==='solo')? 'solo' : (mode==='party' ? 'party' : 'trio');
  switch(exercise){
    case 'pushups':       return { solo:100, trio:500, party:800 }[m];
    case 'squats':        return { solo:150, trio:700, party:1100 }[m];
    case 'situps':        return { solo:120, trio:600, party:900 }[m];
    case 'pullups':       return { solo:25,  trio:80,  party:130 }[m];
    case 'burpees':       return { solo:50,  trio:220, party:360 }[m];
    case 'plank_seconds': return { solo:180, trio:600, party:900 }[m];
    case 'run_miles':     return { solo:2,   trio:5,   party:8 }[m];
    default:              return { solo:100, trio:500, party:800 }[m];
  }
}

/* ---------------- Daily Challenges + Bounties ---------------- */
function Rrange(a,b){ return R(a,b); }
function generateDaily(){
  const packs = [
    { theme:'Upper', tasks:[
      { type:'pushups', desc:'Pushups', target:Rrange(100,160), unit:'reps', xp:Rrange(120,200), coins:Rrange(80,120) },
      { type:'pullups', desc:'Pull-ups', target:Rrange(20,40),  unit:'reps', xp:Rrange(120,180), coins:Rrange(70,110) },
    ]},
    { theme:'Legs', tasks:[
      { type:'squats', desc:'Bodyweight Squats', target:Rrange(150,220), unit:'reps', xp:Rrange(140,200), coins:Rrange(90,130) },
      { type:'run_miles', desc:'Run', target:2, unit:'miles', xp:Rrange(140,200), coins:Rrange(90,120) }
    ]},
    { theme:'Core', tasks:[
      { type:'situps', desc:'Sit-ups', target:Rrange(120,200), unit:'reps', xp:Rrange(120,180), coins:Rrange(70,110) },
      { type:'plank', desc:'Plank', target:Rrange(150,240), unit:'seconds', xp:Rrange(90,140), coins:Rrange(60,90) }
    ]},
    { theme:'Mixed', tasks:[
      { type:'pushups', desc:'Pushups', target:Rrange(100,160), unit:'reps', xp:Rrange(120,180), coins:Rrange(70,110) },
      { type:'run_miles', desc:'Run', target:2, unit:'miles', xp:Rrange(120,180), coins:Rrange(70,110) }
    ]}
  ];
  const pick = packs[R(0,packs.length-1)];
  return { date: todayISO(), theme: pick.theme, tasks: pick.tasks };
}
function ensureDaily(){
  const key = todayISO();
  if (!store._todayDaily[key]){
    store._todayDaily = {};
    store._todayDaily[key] = generateDaily();
    saveSoon();
  }
  return store._todayDaily[key];
}
function dailyEmbed(){
  const d = ensureDaily();
  const lines = d.tasks.map(t=>`• **${t.desc}** — ${t.target} ${t.unit} 〔+${t.xp} XP, +${t.coins} coins〕`);
  return new EmbedBuilder().setTitle(`📆 Daily Challenge — ${d.theme}`).setColor(0x3498db).setDescription(lines.join('\n'));
}
function bountyKey(){ return todayISO(); }
function generateDailyBounty(){
  return {
    date: todayISO(),
    tasks: [
      { type:'pushups', desc:'Pushups', unit:'reps', target: Rrange(120,200), rewardXp:Rrange(120,200), rewardCoins:Rrange(80,130) },
      { type:'squats',  desc:'Bodyweight Squats', unit:'reps', target: Rrange(140,220), rewardXp:Rrange(120,180), rewardCoins:Rrange(70,110) },
      { type:'run_miles', desc:'Run Distance', unit:'miles', target: 2, rewardXp:Rrange(140,190), rewardCoins:Rrange(80,120) }
    ]
  };
}
function ensureDailyBounty(){
  const key = bountyKey();
  if (store.bounties.dailyKey !== key){
    store.bounties.dailyKey = key;
    store.bounties.daily = generateDailyBounty();
    saveSoon();
  }
  return store.bounties.daily;
}
function bountyEmbed(){
  const b = ensureDailyBounty();
  const lines = b.tasks.map(t=>`• **${t.desc}** — ${t.target} ${t.unit} 〔+${t.rewardXp} XP, +${t.rewardCoins} coins〕`);
  return new EmbedBuilder().setTitle(`🎯 Bounty Board — ${b.date}`).setColor(0xE67E22).setDescription(lines.join('\n'));
}

/* ---------------- Shop paging ---------------- */
function shopEmbed(page=1){
  store.shop.items = store.shop.items?.length ? store.shop.items : buildShopItems();
  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(store.shop.items.length/perPage));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p-1)*perPage;
  const items = store.shop.items.slice(start, start+perPage);

  const emb = new EmbedBuilder()
    .setTitle(`🛒 Shop — Page ${p}/${totalPages}`)
    .setColor(0x00C2FF)
    .setDescription(
      items.map(i=>{
        const stats = i.type==='weapon' ? `ATK ${i.atk}` :
                      i.type==='armor'  ? `DEF ${i.def}` :
                      i.type==='trinket'? i.bonus : i.effect;
        const tier = i.tier ? `T${i.tier}` : '—';
        return `• **${i.name}** — ${i.price} coins 〔${i.type}, ${tier}${stats?`, ${stats}`:''}〕`;
      }).join('\n') || '_No items_'
    )
    .setFooter({ text:'Use the buttons to change pages • /buy item:<name> to purchase' });

  return { emb, page:p, totalPages };
}

/* ---------------- Hunts (themeable) ---------------- */
const HUNT_MODES = {
  solo:  { label:'Solo',  maxParty:1,  reward:'decent' },
  trio:  { label:'Trio',  maxParty:3,  reward:'good'   },
  party: { label:'Party', maxParty:5,  reward:'great'  }
};
const HUNT_REWARDS = {
  decent: { coins:[120,220], xp:[150,240], gearOdds: 0.18 },
  good:   { coins:[220,380], xp:[260,420], gearOdds: 0.28 },
  great:  { coins:[360,600], xp:[380,640], gearOdds: 0.38 },
};
function getActiveHunt(channelId){ return store.hunts[channelId] || null; }
function openHunt(channelId, mode, exercise, starterId){
  const m = HUNT_MODES[mode] || HUNT_MODES.trio;
  const theme = EXERCISE_THEMES[exercise] || EXERCISE_THEMES.pushups;
  const target = targetFor(mode, exercise);
  const deadline = Date.now() + (store.config.huntDurationMin||60)*60*1000;
  store.hunts[channelId] = {
    mode, exercise, unit: theme.unit, target, maxParty: m.maxParty, deadline,
    startedBy: starterId,
    participants:{}, total:0, completed:false
  };
  saveSoon();
  return store.hunts[channelId];
}
function joinHunt(channelId, user){
  const h = store.hunts[channelId];
  if (!h) return { error:'No active hunt here. Use `/hunt create`.' };
  if (Object.keys(h.participants).length >= h.maxParty) return { error:`Party is full (${h.maxParty}).` };
  if (h.participants[user]) return { ok:true, joined:false };
  h.participants[user] = { joinedAt: Date.now(), contribution:0 };
  saveSoon();
  return { ok:true, joined:true };
}
function leaveHunt(channelId, user){
  const h = store.hunts[channelId];
  if (!h) return { error:'No active hunt.' };
  delete h.participants[user];
  if (!Object.keys(h.participants).length) delete store.hunts[channelId];
  saveSoon();
  return { ok:true };
}
function huntStatusEmbed(channel){
  const h = store.hunts[channel.id];
  if (!h) return new EmbedBuilder().setTitle('No active hunt').setColor(0x777777);
  const timeLeft = Math.max(0, h.deadline - Date.now());
  const mins = Math.floor(timeLeft/60000), secs = Math.floor((timeLeft%60000)/1000);
  const partLines = Object.entries(h.participants).map(([id,p])=>`• <@${id}> — ${p.contribution} ${h.unit}`);
  const m = HUNT_MODES[h.mode];
  const theme = EXERCISE_THEMES[h.exercise];
  const header = `${m.label} • ${theme.label}`;

  const emb = new EmbedBuilder()
    .setTitle(`🗡️ Hunt: ${header}`)
    .setColor(0x00b894)
    .setDescription([
      `Progress: **${h.total}/${h.target} ${h.unit}**`,
      `Party: ${Object.keys(h.participants).length}/${h.maxParty} • Ends in **${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}**`,
      partLines.length?partLines.join('\n'):'_No participants yet_',
      '',
      `Log **${theme.label}** in this channel while the hunt is active!`
    ].join('\n'))
    .setFooter({ text: 'Each member spends 1 token to join. Gear drops are tier-gated.' });

  const modeKey = ({solo:'pocket_slime', trio:'wolf', party:'ogre'})[h.mode] || 'pocket_slime';
  const { image: artUrl, text: artBlock } = spriteBlockOrImage(modeKey);
  if (artBlock) emb.setDescription(`${artBlock}\n${emb.data.description || ''}`);
  if (artUrl) emb.setImage(artUrl);
  return emb;
}
function resolveHunt(channel){
  const h = store.hunts[channel.id];
  if (!h || h.completed) return;
  h.completed = true;

  const rewardKey = HUNT_MODES[h.mode].reward;
  const pay = HUNT_REWARDS[rewardKey];
  const winners = h.total >= h.target;
  const ids = Object.keys(h.participants);
  const lines = [];

  if (!ids.length) {
    channel.send('❌ Hunt expired with no participants.').catch(()=>{});
    delete store.hunts[channel.id]; saveSoon(); return;
  }

  for (const uid of ids){
    const u = ensureUser(uid);
    if (winners){
      const coins = R(pay.coins[0], pay.coins[1]);
      const xp    = R(pay.xp[0],    pay.xp[1]);
      u.coins += coins; u.xp += xp;

      const lvl = levelFromXp(u.xp);
      const pool = filterGearByTier(store.shop.items, lvl);
      let lootText = 'No gear this time.';
      if (pool.length && Math.random() < pay.gearOdds) {
        const item = pool[R(0, pool.length-1)];
        u.inventory.push(item.name);
        lootText = `**${item.name}** (Tier ${item.tier})`;

        // Item art showcase (per-drop mini embed)
        showcaseItem(channel, uid, item.name, '🗡️ Hunt Loot');
      }
      lines.push(`• <@${uid}>: **+${xp} XP**, **+${coins} coins** — ${lootText}`);
    } else {
      const coins = R(30, 70);
      u.coins += coins;
      lines.push(`• <@${uid}>: **+${coins} coins** (consolation)`);
    }
  }
  saveSoon();

  const title = winners ? '🏆 Hunt Cleared!' : '⌛ Hunt Ended (Failed)';
  channel.send({
    embeds:[ new EmbedBuilder()
      .setTitle(title)
      .setColor(winners ? 0x2ecc71 : 0xe74c3c)
      .setDescription([
        `Mode: **${HUNT_MODES[h.mode].label}** — Theme: **${EXERCISE_THEMES[h.exercise].label}**`,
        `Final: **${h.total}/${h.target} ${h.unit}**`,
        '',
        ...lines
      ].join('\n'))
    ]
  }).catch(()=>{});

  delete store.hunts[channel.id]; saveSoon();
}

/* ---------------- Raids (themeable) ---------------- */
function bossNameForExercise(ex){
  return ({
    pushups:'Titan of Iron',
    squats:'Colossus of Stone',
    situps:'Serpent of Cores',
    pullups:'Spire Warden',
    burpees:'Storm Harrier',
    plank_seconds:'Timebound Phantom',
    run_miles:'Roadbreaker Behemoth'
  }[ex] || 'Ancient Sovereign');
}
function bossHpDefault(ex){
  switch(ex){
    case 'pushups': return 20000;
    case 'squats': return 28000;
    case 'situps': return 24000;
    case 'pullups': return 6000;
    case 'burpees': return 12000;
    case 'plank_seconds': return 36000;
    case 'run_miles': return 800;
    default: return 20000;
  }
}
function raidStatusEmbed(channel){
  const r = store.raids[channel.id];
  if (!r) return new EmbedBuilder().setTitle('No raid active').setColor(0x777777);
  const leftMs = Math.max(0, r.deadline - Date.now());
  const hrs = Math.floor(leftMs/3600000), mins = Math.floor((leftMs%3600000)/60000);
  const lines = Object.entries(r.participants).map(([id,v])=>`• <@${id}> — ${v} ${r.unit}`);
  const barLen = 24;
  const pct = Math.max(0, Math.min(1, 1 - (r.hp / r.hpMax)));
  const filled = Math.round(barLen * pct);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen-filled);

  const { image: artUrl, text: artBlock } = spriteBlockOrImage(r.bossName.toLowerCase().replace(/\s+/g,'_'));
  const desc = [
    artBlock ? artBlock : '',
    `**${r.bossName}** — HP: ${r.hp}/${r.hpMax}`,
    `Progress: ${Math.round(pct*100)}%  ${bar}`,
    `Theme: **${EXERCISE_THEMES[r.exercise].label}** • Ends in **${hrs}h ${mins}m**`,
    '',
    lines.length?lines.join('\n'):'_No participants yet_',
    '',
    `Log **${EXERCISE_THEMES[r.exercise].label}** in this channel to deal damage!`
  ].filter(Boolean).join('\n');

  const emb = new EmbedBuilder().setTitle('🛡️ Raid').setColor(0x9b59b6).setDescription(desc);
  if (artUrl) emb.setImage(artUrl);
  return emb;
}
function endRaid(channel, success){
  const r = store.raids[channel.id]; if (!r) return;
  const ids = Object.keys(r.participants);
  const lines = [];
  if (!ids.length){
    channel.send('Raid ended with no participants.').catch(()=>{});
    delete store.raids[channel.id]; saveSoon(); return;
  }
  for (const uid of ids){
    const u = ensureUser(uid);
    if (success){
      const coins = R(600, 1200);
      const xp    = R(800, 1600);
      u.coins += coins; u.xp += xp;
      const lvl = levelFromXp(u.xp);
      const pool = filterGearByTier(store.shop.items, lvl);
      let lootText = 'No gear this time.';
      if (pool.length && Math.random() < 0.25) {
        const item = pool[R(0,pool.length-1)];
        u.inventory.push(item.name);
        lootText = `**${item.name}** (Tier ${item.tier})`;
        showcaseItem(channel, uid, item.name, '🏰 Raid Loot');
      }
      lines.push(`• <@${uid}>: +${xp} XP, +${coins} coins — ${lootText}`);
    } else {
      const coins = R(120, 260);
      u.coins += coins;
      lines.push(`• <@${uid}>: +${coins} coins (consolation)`);
    }
  }
  saveSoon();

  channel.send({ embeds:[
    new EmbedBuilder()
      .setTitle(success? '🏰 RAID CLEARED!' : '⌛ Raid Ended')
      .setColor(success? 0x2ecc71 : 0xe74c3c)
      .setDescription([ success? '**Heroes prevail!**' : '**The boss endured… this time.**', '', ...lines ].join('\n'))
  ]}).catch(()=>{});

  delete store.raids[channel.id]; saveSoon();
}

/* ---------------- Player Power (for classic modes) ---------------- */
function playerPower(user){
  const lvl = levelFromXp(user.xp);
  let pow = 12 + lvl * 2.2;
  const w = user.equipped?.weapon;
  const a = user.equipped?.armor;
  const weapon = store.shop.items.find(i=>i.name===w);
  const armor  = store.shop.items.find(i=>i.name===a);
  if (weapon?.atk) pow += weapon.atk * 2.2;
  if (armor?.def)  pow += armor.def  * 1.6;
  if (user.equipped?.pet) pow += 2;
  if (user.equipped?.mount) pow += 3;
  return Math.max(10, Math.floor(pow));
}

/* ---------------- Item Showcase Helper (art on equip/loot) ---------------- */
async function showcaseItem(channel, userId, itemName, title='🎁 New Item'){
  const { image: artUrl, text: artBlock } = spriteBlockOrImage(itemName);
  const emb = new EmbedBuilder()
    .setTitle(`${title}`)
    .setColor(0x00c2ff)
    .setDescription(`${artBlock?artBlock+'\n':''}**<@${userId}>** obtained **${itemName}**`);
  if (artUrl) emb.setImage(artUrl);
  channel.send({ embeds:[emb] }).catch(()=>{});
}

/* ---------------- Commands ---------------- */
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Latency check'),
  new SlashCommandBuilder().setName('help').setDescription('Show commands & tips'),
  new SlashCommandBuilder().setName('profile').setDescription('View your stats'),

  new SlashCommandBuilder().setName('log').setDescription('Log a workout')
    .addStringOption(o=>o.setName('type').setDescription('Exercise type').setRequired(true)
      .addChoices(
        {name:'Pushups',value:'pushups'},{name:'Sit-ups',value:'situps'},{name:'Squats',value:'squats'},
        {name:'Pull-ups',value:'pullups'},{name:'Burpees',value:'burpees'},{name:'Plank (seconds)',value:'plank'},
        {name:'Run (miles)',value:'run_miles'}
      ))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount (reps / seconds / miles)').setRequired(true)),

  new SlashCommandBuilder().setName('p').setDescription('Quick: log pushups')
    .addIntegerOption(o=>o.setName('amount').setDescription('reps').setRequired(true)),
  new SlashCommandBuilder().setName('plank').setDescription('Quick: log plank seconds')
    .addIntegerOption(o=>o.setName('amount').setDescription('seconds').setRequired(true)),
  new SlashCommandBuilder().setName('run').setDescription('Quick: log run miles')
    .addNumberOption(o=>o.setName('miles').setDescription('miles').setRequired(true)),

  new SlashCommandBuilder().setName('shop').setDescription('Open the shop')
    .addIntegerOption(o=>o.setName('page').setDescription('Page number (1-based)').setRequired(false)),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item by exact name')
    .addStringOption(o=>o.setName('item').setDescription('Exact item name').setRequired(true)),
  new SlashCommandBuilder().setName('equip').setDescription('Equip a weapon/armor/trinket')
    .addStringOption(o=>o.setName('item').setDescription('Exact item name').setRequired(true)),
  new SlashCommandBuilder().setName('summonpet').setDescription('Summon a pet')
    .addStringOption(o=>o.setName('item').setDescription('Exact pet name').setRequired(true)),
  new SlashCommandBuilder().setName('equipmount').setDescription('Equip a mount')
    .addStringOption(o=>o.setName('item').setDescription('Exact mount name').setRequired(true)),

  new SlashCommandBuilder().setName('setart').setDescription('Admin: set art image for key or name')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('key').setDescription('monster key or item name').setRequired(true))
    .addAttachmentOption(o=>o.setName('image').setDescription('Upload an image').setRequired(true)),

  new SlashCommandBuilder().setName('daily').setDescription('Daily challenge')
    .addSubcommand(s=>s.setName('show').setDescription('Show today’s daily challenge'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim once you’ve done it')),

  new SlashCommandBuilder().setName('bounty').setDescription('Daily bounty')
    .addSubcommand(s=>s.setName('show').setDescription('Show today’s bounties'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim bounty rewards')),

  // Hunts (themeable)
  new SlashCommandBuilder().setName('hunt').setDescription('Workout hunt (themed)')
    .addSubcommand(s=>s.setName('create').setDescription('Start a hunt here')
      .addStringOption(o=>o.setName('mode').setDescription('solo|trio|party').setRequired(true)
        .addChoices({name:'solo',value:'solo'},{name:'trio',value:'trio'},{name:'party',value:'party'}))
      .addStringOption(o=>o.setName('exercise').setDescription('Exercise theme').setRequired(true)
        .addChoices(
          {name:'Pushups',value:'pushups'},{name:'Squats',value:'squats'},{name:'Sit-ups',value:'situps'},
          {name:'Pull-ups',value:'pullups'},{name:'Burpees',value:'burpees'},
          {name:'Plank (seconds)',value:'plank_seconds'},{name:'Run (miles)',value:'run_miles'}
        )))
    .addSubcommand(s=>s.setName('join').setDescription('Join the active hunt (costs 1 token)'))
    .addSubcommand(s=>s.setName('status').setDescription('See current hunt progress'))
    .addSubcommand(s=>s.setName('leave').setDescription('Leave the hunt'))
    .addSubcommand(s=>s.setName('cancel').setDescription('Admin: cancel hunt')),

  // Raids (themeable)
  new SlashCommandBuilder().setName('raid').setDescription('Themeable raid')
    .addSubcommand(s=>s.setName('create').setDescription('Start a raid (admin)')
      .addStringOption(o=>o.setName('exercise').setDescription('Damage exercise').setRequired(true)
        .addChoices(
          {name:'Pushups',value:'pushups'},{name:'Squats',value:'squats'},{name:'Sit-ups',value:'situps'},
          {name:'Pull-ups',value:'pullups'},{name:'Burpees',value:'burpees'},
          {name:'Plank (seconds)',value:'plank_seconds'},{name:'Run (miles)',value:'run_miles'}
        ))
      .addIntegerOption(o=>o.setName('hp').setDescription('Boss HP (default auto)').setRequired(false))
      .addIntegerOption(o=>o.setName('hours').setDescription('Duration in hours (default 24)').setRequired(false))
      .addStringOption(o=>o.setName('name').setDescription('Boss name').setRequired(false)))
    .addSubcommand(s=>s.setName('status').setDescription('Raid status'))
    .addSubcommand(s=>s.setName('cancel').setDescription('Admin: cancel raid'))
];

/* ---------------- Command registration ---------------- */
async function registerCommands(){
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map(c=>c.toJSON()) });
  console.log('✅ Commands registered');
}

/* ---------------- Level roles & flashy messages ---------------- */
const LEVEL_ROLES = [
  { level: 1,   roleName: 'Novice' },
  { level: 5,   roleName: 'Apprentice' },
  { level: 10,  roleName: 'Warrior' },
  { level: 20,  roleName: 'Champion' },
  { level: 40,  roleName: 'Legend' },
  { level: 90,  roleName: 'Mythic' },
  { level: 150, roleName: 'Ascendant' },
  { level: 225, roleName: 'Paragon' },
  { level: 325, roleName: 'Eternal' },
  { level: 450, roleName: 'Transcendent' },
  { level: 600, roleName: 'Celestial' },
  { level: 750, roleName: 'Apex' },
  { level: 900, roleName: 'Omnilegend' }
];
async function applyLevelRole(member, lvl){
  const tier = [...LEVEL_ROLES].reverse().find(r=>lvl>=r.level);
  if (!tier) return;
  try {
    const role = member.guild.roles.cache.find(r=>r.name===tier.roleName) ||
      await member.guild.roles.create({ name:tier.roleName, color:'Random', reason:'FitRPG level role' });
    await member.roles.add(role);
  } catch(e){ console.warn('Role apply failed', e); }
}
async function sendLevelUp(member, newLevel){
  const channelId = store.config.levelUpChannelId || LEVELUP_CHANNEL_ID;
  const ch = channelId ? await member.client.channels.fetch(channelId).catch(()=>null) : member.guild.systemChannel;
  const titles = ['LEVEL UP!', 'POWER SURGE!', 'NEW RANK!'];
  const title = titles[R(0,titles.length-1)];
  const emb = new EmbedBuilder()
    .setTitle(`🎉✨ ${title} ✨🎉`)
    .setColor(0xf1c40f)
    .setDescription(`**${member.user.username}** reached **Level ${newLevel}**!`)
    .setThumbnail(member.user.displayAvatarURL());
  if (ch) ch.send({ embeds:[emb] }).catch(()=>{});
}

/* ---------------- Workout log & XP ---------------- */
function computeXp(type, amount, user){
  const cfg = BUILT_INS[type];
  if (!cfg) return 0;
  let xp = amount * (cfg.rate || 0);
  const lvl = levelFromXp(user.xp);
  if (lvl < 5) xp *= 1.2;
  else if (lvl < 20) xp *= 1.1;
  if (user.equipped?.pet === 'Pocket Slime') xp *= 1.02;
  if (user.equipped?.pet === 'Trail Hawk' && type==='run_miles') xp *= 1.03;
  return Math.round(xp);
}
async function doWorkoutLog(interaction, type, amount){
  const user = ensureUser(interaction.user.id);
  const now = Date.now();
  if (now - user.lastLog < (store.config.logCooldownSec||10)*1000){
    const wait = Math.ceil((((store.config.logCooldownSec||10)*1000)-(now-user.lastLog))/1000);
    return interaction.reply({ content:`⏳ Log cooldown. Try again in ${wait}s.`, ephemeral:true });
  }
  const cfg = BUILT_INS[type];
  if (!cfg) return interaction.reply({ content:'❌ Unsupported exercise.', ephemeral:true });
  if (amount<=0) return interaction.reply({ content:'❌ Amount must be positive.', ephemeral:true });

  const xpGain = computeXp(type, amount, user);
  const preLevel = levelFromXp(user.xp);
  user.xp += xpGain;
  user.coins += Math.max(1, Math.floor(xpGain/3));
  user.tokens += 1;
  user.lastLog = now;
  user.lastActiveISO = todayISO();

  // Hunt contribution
  try {
    const h = interaction.channel && store.hunts[interaction.channel.id];
    if (h && !h.completed && Date.now() < h.deadline && h.participants[interaction.user.id]) {
      let add = 0;
      switch(h.exercise){
        case 'pushups':       if (type==='pushups') add = amount; break;
        case 'squats':        if (type==='squats') add = amount; break;
        case 'situps':        if (type==='situps') add = amount; break;
        case 'pullups':       if (type==='pullups') add = amount; break;
        case 'burpees':       if (type==='burpees') add = amount; break;
        case 'plank_seconds': if (type==='plank')   add = amount; break;
        case 'run_miles':     if (type==='run_miles') add = amount; break;
      }
      if (add > 0){
        h.total += add;
        h.participants[interaction.user.id].contribution += add;
        if (h.total >= h.target) resolveHunt(interaction.channel);
        else saveSoon();
      }
    }
  } catch(e){ console.error('HUNT_PROGRESS_ERROR', e); }

  // Raid contribution
  try {
    const r = interaction.channel && store.raids[interaction.channel.id];
    if (r && !r.done && Date.now() < r.deadline && r.hp > 0) {
      let dmg = 0;
      switch(r.exercise){
[Message clipped]  View entire message
