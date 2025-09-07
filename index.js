// FitRPG Bot — Mobile-first RPG (Images-only art, easy XP, raids auto-update, hunts 1–5, inventory & adventure)
// CommonJS + discord.js v14
// IMPORTANT: add package.json with Node 20 + type: commonjs (see bottom of this message).

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
const https = require('https');

/* ---------------- Health server (keeps Render alive) ---------------- */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('FitRPG bot is running.\n');
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

/* Optional self-ping */
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || null;
if (KEEPALIVE_URL) {
  setInterval(() => {
    try {
      const lib = KEEPALIVE_URL.startsWith('https') ? https : http;
      lib.get(KEEPALIVE_URL, () => {}).on('error', ()=>{});
    } catch {}
  }, 4 * 60 * 1000);
}

/* ---------------- ENV ---------------- */
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID; // Application (Client) ID
const guildId  = process.env.GUILD_ID;  // Server (Guild) ID
const LEVELUP_CHANNEL_ID = process.env.LEVELUP_CHANNEL_ID || null;
const DAILY_CHANNEL_ID   = process.env.DAILY_CHANNEL_ID   || null;
const MONGO_URI          = process.env.MONGO_URI || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

/* ---------------- Persistence (Mongo optional) ---------------- */
const USE_MONGO = !!MONGO_URI;
let mongo = null;
async function initMongo(){
  if(!USE_MONGO) return;
  const { MongoClient } = require('mongodb');
  mongo = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  await mongo.connect();
  console.log('✅ MongoDB connected');
}
const DATA_FILE = 'data.json';

let store = {
  users: {},           // id -> user state
  shop: { items: [] }, // static items; we build defaults if empty
  events: [],
  raids: {},           // channelId -> { ... , messageId }
  hunts: {},           // channelId -> hunt object
  bounties: { dailyKey: null, daily: null },
  artMap: {},          // key -> image url for items/monsters/pets/mounts
  _todayDaily: {},     // dateISO -> { theme, tasks }
  config: {
    timezoneNote: 'America/Chicago',
    levelUpChannelId: LEVELUP_CHANNEL_ID,
    dailyChannelId: DAILY_CHANNEL_ID,
    logCooldownSec: 10,
    raidHitCooldownSec: 8,
    huntCooldownSec: 20,
    huntDurationMin: 60,
    dailyPost: { hour: 0, minute: 1, tz: 'America/Chicago' } // 00:01 CT
  }
};

function ensureUser(id){
  if(!store.users[id]) store.users[id] = {
    xp:0, coins:0, tokens:0,
    inventory:[],
    equipped:{weapon:null,armor:null,trinket:null,cosmetic:null, pet:null, mount:null},
    lastLog:0, lastRaidHit:0, lastHunt:0, lastAdventure:0,
    lastActiveISO:null, streak:0,
    dailyProgress:{},
    _buffs:{},
    bestiary:{} // name -> kills
  };
  return store.users[id];
}

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
    fs.writeFileSync(DATA_FILE, JSON.stringify(store,null,2));
  }
}
let saveTimer=null;
function saveSoon(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>saveStore().catch(console.error), 400); }

/* ---------------- Utils ---------------- */
function R(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi, n)); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function getNowInTZ(tz) { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); }

/* ---------------- XP / Level (reverted easier model) ---------------- */
/* Per your earlier preference:
   - Running: 40 XP per mile
   - Pushups: 0.50 XP / rep
   - Plank:   0.20 XP / sec
   + Similar for other moves
   Level curve: smooth, fast early, still scales to 1000. */
function xpForLevel(level){
  if (level <= 1) return 80;
  const base = 45;                 // lower than before (easier)
  return Math.floor(base * Math.pow(level, 1.08) + 30);
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

/* ---------------- Exercises & XP rates (reverted) ---------------- */
const BUILT_INS = {
  // bodyweight
  pushups:{ unit:'reps', rate:0.50 }, situps:{ unit:'reps', rate:0.40 }, squats:{ unit:'reps', rate:0.40 },
  lunges:{ unit:'reps', rate:0.45 }, burpees:{ unit:'reps', rate:1.20 }, pullups:{ unit:'reps', rate:2.00 }, dips:{ unit:'reps', rate:1.60 },
  // time
  plank:{ unit:'seconds', rate:0.20 },
  // cardio
  run_miles:{ unit:'miles', rate:40 }, run:{ unit:'minutes', rate:0.35 }, cycle_miles:{ unit:'miles', rate:14 },
  row_minutes:{ unit:'minutes', rate:0.45 }, swim_laps:{ unit:'laps', rate:20 },
  // session (generic)
  strengthsession:{ unit:'sessions', rate:40 }
};

/* ---------------- Tier gating (T1–T10) ---------------- */
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

/* ---------------- Shop Items (Weapons/Armor/Trinkets/Pets/Mounts up to T10) ---------------- */
function buildShopItems(){
  const weapons = [
    { name:'Wooden Club',       type:'weapon', tier:1,  atk:2,  price:120 },
    { name:'Bronze Dagger',     type:'weapon', tier:1,  atk:3,  price:180 },
    { name:'Iron Sword',        type:'weapon', tier:2,  atk:6,  price:420 },
    { name:'Steel Saber',       type:'weapon', tier:2,  atk:8,  price:650 },
    { name:'Runed Blade',       type:'weapon', tier:3,  atk:12, price:1200 },
    { name:'Sunforged Spear',   type:'weapon', tier:4,  atk:18, price:2000 },
    { name:'Dragonbone Axe',    type:'weapon', tier:5,  atk:26, price:3100 },
    { name:'Celestial Halberd', type:'weapon', tier:6,  atk:35, price:4500 },
    { name:'Starpiercer Lance', type:'weapon', tier:7,  atk:46, price:6400 },
    { name:'Voidreaver Scythe', type:'weapon', tier:8,  atk:58, price:8800 },
    { name:'Aurora Greatsword', type:'weapon', tier:9,  atk:72, price:12000 },
    { name:'Transcendent Blade',type:'weapon', tier:10, atk:90, price:16000 }
  ];
  const armors = [
    { name:'Padded Vest',        type:'armor', tier:1,  def:2,  price:110 },
    { name:'Leather Coat',       type:'armor', tier:1,  def:3,  price:170 },
    { name:'Chainmail',          type:'armor', tier:2,  def:6,  price:420 },
    { name:'Scale Plate',        type:'armor', tier:2,  def:8,  price:650 },
    { name:'Runed Aegis',        type:'armor', tier:3,  def:12, price:1200 },
    { name:'Sunforged Plate',    type:'armor', tier:4,  def:18, price:2000 },
    { name:'Dragonhide Mail',    type:'armor', tier:5,  def:26, price:3100 },
    { name:'Celestial Carapace', type:'armor', tier:6,  def:35, price:4500 },
    { name:'Aegis of Dawn',      type:'armor', tier:7,  def:46, price:6300 },
    { name:'Eclipse Barrier',    type:'armor', tier:8,  def:58, price:8700 },
    { name:'Mythril Bastion',    type:'armor', tier:9,  def:72, price:11800 },
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
  const pets = [
    { name:'Pocket Slime',   type:'pet',   tier:2,  bonus:'+2% XP from logs',          price:900  },
    { name:'Trail Hawk',     type:'pet',   tier:3,  bonus:'+3% run XP',                price:1200 },
    { name:'Cinder Pup',     type:'pet',   tier:4,  bonus:'+3 Power in hunts',         price:1800 },
    { name:'Glacier Cub',    type:'pet',   tier:5,  bonus:'+4% plank XP',              price:2400 },
    { name:'Storm Lynx',     type:'pet',   tier:6,  bonus:'+5% coins',                 price:3200 },
    { name:'Dune Raptor',    type:'pet',   tier:7,  bonus:'+6% hunt loot',             price:4200 },
    { name:'Aether Wisp',    type:'pet',   tier:8,  bonus:'+8% all XP',                price:5600 },
    { name:'Sun Phoenix',    type:'pet',   tier:9,  bonus:'+10% adventure loot',       price:7400 },
    { name:'Time Dragonling',type:'pet',   tier:10, bonus:'+12% all XP, +2 raid Power',price:9800 }
  ];
  const mounts = [
    { name:'Sprint Goat',   type:'mount', tier:3,  bonus:'+5% hunt token chance',   price:1500 },
    { name:'Shadow Steed',  type:'mount', tier:4,  bonus:'+5 Power in hunts',       price:2200 },
    { name:'Crystal Stag',  type:'mount', tier:5,  bonus:'+6% run XP',              price:3000 },
    { name:'Thunder Elk',   type:'mount', tier:6,  bonus:'+6 raid Power',           price:3800 },
    { name:'Sand Strider',  type:'mount', tier:7,  bonus:'+8% coins',               price:4800 },
    { name:'Cloud Roc',     type:'mount', tier:8,  bonus:'+8% daily rewards',       price:6200 },
    { name:'Star Gryphon',  type:'mount', tier:9,  bonus:'+10% hunt loot',          price:8200 },
    { name:'Void Drake',    type:'mount', tier:10, bonus:'+12% everything (flavor)',price:11000 }
  ];
  const consumables = [
    { name:'Health Potion', type:'consumable', effect:'Flavor heal', price:100 },
    { name:'Energy Drink',  type:'consumable', effect:'+10% XP next log', price:160 },
    { name:'Treasure Map',  type:'consumable', effect:'Guarantee loot on /adventure', price:500 }
  ];
  return [...weapons, ...armors, ...trinkets, ...pets, ...mounts, ...consumables];
}
store.shop.items = store.shop.items?.length ? store.shop.items : buildShopItems();

/* ---------------- Art helper (images only) ---------------- */
function artURL(key){
  if (!key) return null;
  return store.artMap[key] || store.artMap[key.toLowerCase()] || store.artMap[key.replace(/\s+/g,'_').toLowerCase()] || null;
}

/* ---------------- Exercise themes (for hunts/raids) ---------------- */
const EXERCISE_THEMES = {
  pushups:      { label:'Pushups',      unit:'reps',   key:'pushups' },
  squats:       { label:'Bodyweight Squats', unit:'reps', key:'squats' },
  situps:       { label:'Sit-ups',      unit:'reps',   key:'situps' },
  pullups:      { label:'Pull-ups',     unit:'reps',   key:'pullups' },
  burpees:      { label:'Burpees',      unit:'reps',   key:'burpees' },
  plank_seconds:{ label:'Plank (seconds)', unit:'seconds', key:'plank' },
  run_miles:    { label:'Run Distance', unit:'miles',  key:'run_miles' }
};
function targetFor(exercise, partySize){
  // Your examples: 1:100 pushups / 3:500 / 5:800, roughly scale
  const base = {
    pushups:100, squats:150, situps:120, pullups:25, burpees:50, plank_seconds:180, run_miles:2
  };
  const add = { 1:0, 2:60, 3:400, 4:600, 5:800 };
  const b = base[exercise] ?? 100;
  return (exercise==='run_miles')
    ? ( {1:2,2:3,3:5,4:7,5:8}[partySize] ?? 2 )
    : b + (add[partySize] ?? 0);
}

/* ---------------- Daily Challenges + Bounties (unchanged from last build) ---------------- */
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
      { type:'pushups',   desc:'Pushups',            unit:'reps',   target: Rrange(120,200), rewardXp:Rrange(120,200), rewardCoins:Rrange(80,130) },
      { type:'squats',    desc:'Bodyweight Squats', unit:'reps',   target: Rrange(140,220), rewardXp:Rrange(120,180), rewardCoins:Rrange(70,110) },
      { type:'run_miles', desc:'Run Distance',      unit:'miles',  target: 2,               rewardXp:Rrange(140,190), rewardCoins:Rrange(80,120) }
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

/* ---------------- Hunts (workout-gated, party size 1–5) ---------------- */
const HUNT_REWARDS = {
  1: { coins:[120,220], xp:[150,240], gearOdds: 0.18 },
  2: { coins:[180,300], xp:[200,320], gearOdds: 0.22 },
  3: { coins:[220,380], xp:[260,420], gearOdds: 0.28 },
  4: { coins:[300,520], xp:[320,540], gearOdds: 0.34 },
  5: { coins:[360,600], xp:[380,640], gearOdds: 0.38 }
};
function getActiveHunt(channelId){ return store.hunts[channelId] || null; }
function openHunt(channelId, partySize, exercise, starterId){
  const theme = EXERCISE_THEMES[exercise] || EXERCISE_THEMES.pushups;
  const target = targetFor(exercise, partySize);
  const deadline = Date.now() + (store.config.huntDurationMin||60)*60*1000;
  store.hunts[channelId] = {
    partySize: clamp(partySize,1,5), exercise, unit: theme.unit, target,
    maxParty: clamp(partySize,1,5), deadline,
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
  const theme = EXERCISE_THEMES[h.exercise];
  const header = `Party ${Object.keys(h.participants).length}/${h.maxParty} • ${theme.label}`;

  const emb = new EmbedBuilder()
    .setTitle(`🗡️ Hunt (${h.partySize})`)
    .setColor(0x00b894)
    .setDescription([
      `**${header}**`,
      `Progress: **${h.total}/${h.target} ${h.unit}**`,
      `Ends in **${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}**`,
      partLines.length?partLines.join('\n'):'_No participants yet_',
      '',
      `Log **${theme.label}** in this channel while the hunt is active!`
    ].join('\n'));
  return emb;
}
async function resolveHunt(channel){
  const h = store.hunts[channel.id];
  if (!h || h.completed) return;
  h.completed = true;

  const pay = HUNT_REWARDS[h.partySize] || HUNT_REWARDS[3];
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
        lootText = `**${item.name}** (T${item.tier})`;
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

  channel.send({
    embeds:[ new EmbedBuilder()
      .setTitle(winners ? '🏆 Hunt Cleared!' : '⌛ Hunt Ended (Failed)')
      .setColor(winners ? 0x2ecc71 : 0xe74c3c)
      .setDescription([
        `Party Size: **${h.partySize}** — Theme: **${EXERCISE_THEMES[h.exercise].label}**`,
        `Final: **${h.total}/${h.target} ${h.unit}**`,
        '',
        ...lines
      ].join('\n'))
    ]
  }).catch(()=>{});

  delete store.hunts[channel.id]; saveSoon();
}

/* ---------------- Raids (auto-updating status embed) ---------------- */
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
  const barLen = 28;
  const pct = Math.max(0, Math.min(1, 1 - (r.hp / r.hpMax)));
  const filled = Math.round(barLen * pct);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen-filled);

  const desc = [
    `**${r.bossName}** — HP: ${r.hp}/${r.hpMax}`,
    `Progress: ${Math.round(pct*100)}%  ${bar}`,
    `Theme: **${EXERCISE_THEMES[r.exercise].label}** • Ends in **${hrs}h ${mins}m**`,
    '',
    lines.length?lines.join('\n'):'_No participants yet_',
    '',
    `Log **${EXERCISE_THEMES[r.exercise].label}** in this channel to deal damage!`
  ].join('\n');

  const emb = new EmbedBuilder().setTitle('🛡️ Raid').setColor(0x9b59b6).setDescription(desc);
  const art = artURL(r.bossName) || artURL(r.bossName.toLowerCase().replace(/\s+/g,'_'));
  if (art) emb.setImage(art);
  return emb;
}
async function postOrUpdateRaidMessage(channel){
  const r = store.raids[channel.id];
  if (!r) return;
  const emb = raidStatusEmbed(channel);
  try {
    if (r.messageId) {
      const msg = await channel.messages.fetch(r.messageId).catch(()=>null);
      if (msg) { await msg.edit({ embeds:[emb] }); return; }
    }
    const sent = await channel.send({ embeds:[emb] });
    r.messageId = sent.id; saveSoon();
  } catch(e){ /* ignore */ }
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
        lootText = `**${item.name}** (T${item.tier})`;
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

/* ---------------- Player Power (classic calc) ---------------- */
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

/* ---------------- Item Showcase (images only) ---------------- */
async function showcaseItem(channel, userId, itemName, title='🎁 New Item'){
  const url = artURL(itemName);
  const emb = new EmbedBuilder()
    .setTitle(`${title}`)
    .setColor(0x00c2ff)
    .setDescription(`**<@${userId}>** obtained **${itemName}**`);
  if (url) emb.setImage(url);
  channel.send({ embeds:[emb] }).catch(()=>{});
}

/* ---------------- Commands ---------------- */
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Latency check'),
  new SlashCommandBuilder().setName('help').setDescription('Show commands & tips'),
  new SlashCommandBuilder().setName('profile').setDescription('View your stats'),
  new SlashCommandBuilder().setName('inventory').setDescription('See what you own'),

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
  new SlashCommandBuilder().setName('summonpet').setDescription('Equip a pet')
    .addStringOption(o=>o.setName('item').setDescription('Exact pet name').setRequired(true)),
  new SlashCommandBuilder().setName('equipmount').setDescription('Equip a mount')
    .addStringOption(o=>o.setName('item').setDescription('Exact mount name').setRequired(true)),

  new SlashCommandBuilder().setName('setart').setDescription('Admin: set art image for key or name')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('key').setDescription('monster or item name').setRequired(true))
    .addAttachmentOption(o=>o.setName('image').setDescription('Upload an image').setRequired(true)),

  new SlashCommandBuilder().setName('daily').setDescription('Daily challenge')
    .addSubcommand(s=>s.setName('show').setDescription('Show today’s daily challenge'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim once you’ve done it')),

  new SlashCommandBuilder().setName('bounty').setDescription('Daily bounty')
    .addSubcommand(s=>s.setName('show').setDescription('Show today’s bounties'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim bounty rewards')),

  // Hunts: choose party size (1–5) + exercise
  new SlashCommandBuilder().setName('hunt').setDescription('Workout hunt (themed)')
    .addSubcommand(s=>s.setName('create').setDescription('Start a hunt here')
      .addIntegerOption(o=>o.setName('size').setDescription('Party size 1–5').setRequired(true).setMinValue(1).setMaxValue(5))
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

  // Raids (themeable + auto-updating message)
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
    .addSubcommand(s=>s.setName('cancel').setDescription('Admin: cancel raid')),

  // Adventure (token-gated loot-first)
  new SlashCommandBuilder().setName('adventure').setDescription('Spend 1 token for a quick adventure'),
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
  const emb = new EmbedBuilder()
    .setTitle(`🎉✨ LEVEL UP! ✨🎉`)
    .setColor(0xf1c40f)
    .setDescription(`**${member.user.username}** reached **Level ${newLevel}**!`)
    .setThumbnail(member.user.displayAvatarURL());
  if (ch) ch.send({ embeds:[emb] }).catch(()=>{});
}

/* ---------------- XP bar builder ---------------- */
function xpBar(user){
  const lvl = levelFromXp(user.xp);
  const need = xpForLevel(lvl+1);
  const prog = user.xp - totalXpForLevel(lvl);
  const barLen=20, pct = Math.max(0, Math.min(1, prog/Math.max(1,need)));
  const filled = Math.round(barLen*pct);
  return { lvl, need, prog, bar: '█'.repeat(filled) + '░'.repeat(barLen-filled), pct: Math.round(pct*100) };
}

/* ---------------- Workout log & XP (with bar + raid auto-update) ---------------- */
function computeXp(type, amount, user){
  const cfg = BUILT_INS[type];
  if (!cfg) return 0;
  let xp = amount * (cfg.rate || 0);
  const lvl = levelFromXp(user.xp);
  if (lvl < 5) xp *= 1.2;
  else if (lvl < 20) xp *= 1.1;
  // simple pet perks
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
  const coinGain = Math.max(1, Math.floor(xpGain/3));
  user.coins += coinGain;
  user.tokens += 1; // 1 token per log
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
        if (h.total >= h.target) await resolveHunt(interaction.channel);
        else { saveSoon(); interaction.channel.send({ embeds:[huntStatusEmbed(interaction.channel)] }).catch(()=>{}); }
      }
    }
  } catch(e){ console.error('HUNT_PROGRESS_ERROR', e); }

  // Raid contribution (auto-update embed)
  try {
    const r = interaction.channel && store.raids[interaction.channel.id];
    if (r && !r.done && Date.now() < r.deadline && r.hp > 0) {
      let dmg = 0;
      switch(r.exercise){
        case 'pushups':       if (type==='pushups') dmg = amount; break;
        case 'squats':        if (type==='squats') dmg = amount; break;
        case 'situps':        if (type==='situps') dmg = amount; break;
        case 'pullups':       if (type==='pullups') dmg = amount; break;
        case 'burpees':       if (type==='burpees') dmg = amount; break;
        case 'plank_seconds': if (type==='plank')   dmg = amount; break;
        case 'run_miles':     if (type==='run_miles') dmg = amount; break;
      }
      if (dmg > 0){
        r.hp = Math.max(0, r.hp - dmg);
        r.participants[interaction.user.id] = (r.participants[interaction.user.id]||0) + dmg;
        if (r.hp === 0){ r.done = true; saveSoon(); endRaid(interaction.channel, true); }
        else { saveSoon(); await postOrUpdateRaidMessage(interaction.channel); }
      }
    }
  } catch(e){ console.error('RAID_PROGRESS_ERROR', e); }

  saveSoon();

  // XP bar reply (always visible)
  const bar = xpBar(user);
  const emb = new EmbedBuilder()
    .setTitle('✅ Workout logged!')
    .setColor(0x1abc9c)
    .setDescription([
      `**${amount} ${cfg.unit}** ${EXERCISE_THEMES[type]?.label || type}`,
      `+${xpGain} XP • +${coinGain} coins • +1 token`,
      '',
      `Level **${bar.lvl}**  —  ${bar.prog}/${bar.need} XP  (${bar.pct}%)`,
      `${bar.bar}`
    ].join('\n'))
    .setThumbnail(interaction.user.displayAvatarURL());
  await interaction.reply({ embeds:[emb] });

  // Flashy level-up (separate message in level-up channel)
  const newLevel = levelFromXp(user.xp);
  if (newLevel > preLevel){
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
    if (member) {
      await sendLevelUp(member, newLevel);
      await applyLevelRole(member, newLevel);
    }
  }
}

/* ---------------- Welcome ---------------- */
client.on('guildMemberAdd', async (member) => {
  const ch = store.config.levelUpChannelId ? await client.channels.fetch(store.config.levelUpChannelId).catch(()=>null) : member.guild.systemChannel;
  if (!ch) return;
  const emb = new EmbedBuilder()
    .setTitle('🎉 A new challenger approaches!')
    .setColor(0x00d084)
    .setDescription(`Welcome **${member.user.username}**!\nUse **/help** to see commands.\nLog workouts with **/p**, **/plank**, **/run** or **/log**.\nStart a hunt with **/hunt create**.`)
    .setThumbnail(member.user.displayAvatarURL());
  ch.send({ content:`<@${member.id}>`, embeds:[emb] }).catch(()=>{});
});

/* ---------------- Adventure (token-gated, loot-first) ---------------- */
async function doAdventure(interaction){
  const u = ensureUser(interaction.user.id);
  const now = Date.now();
  if (now - u.lastAdventure < (store.config.huntCooldownSec||20)*1000){
    const wait = Math.ceil((((store.config.huntCooldownSec||20)*1000)-(now-u.lastAdventure))/1000);
    return interaction.reply({ content:`⏳ Adventure cooldown. Try again in ${wait}s.`, ephemeral:true });
  }
  if ((u.tokens||0) <= 0) return interaction.reply({ content:'⚠️ You need 1 token. Log a workout to earn tokens.', ephemeral:true });

  u.tokens -= 1;
  u.lastAdventure = now;

  // modest xp/coin, chance at tier-gated gear
  const xp = R(80,140);
  const coins = R(90,160);
  u.xp += xp; u.coins += coins;
  const lvl = levelFromXp(u.xp);
  const pool = filterGearByTier(store.shop.items, lvl);
  let loot = null;
  if (pool.length && Math.random() < 0.25) {
    loot = pool[R(0,pool.length-1)];
    u.inventory.push(loot.name);
  }
  saveSoon();

  const lines = [`**Adventure complete!** +${xp} XP, +${coins} coins`];
  if (loot){
    lines.push(`Loot: **${loot.name}** (T${loot.tier})`);
  } else {
    lines.push(`No gear this time. Use a **Treasure Map** to guarantee loot.`);
  }

  const url = loot ? artURL(loot.name) : null;
  const emb = new EmbedBuilder().setTitle('🧭 Adventure').setColor(0x2ecc71).setDescription(lines.join('\n'));
  if (url) emb.setImage(url);

  return interaction.reply({ embeds:[emb] });
}

/* ---------------- Interactions ---------------- */
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()){
      const user = ensureUser(interaction.user.id);
      switch (interaction.commandName){

        case 'ping': {
          await interaction.reply({ content:'🏓 Pong!' });
          return;
        }

        case 'help': {
          const emb = new EmbedBuilder()
            .setTitle('📖 FitRPG Help')
            .setColor(0x95a5a6)
            .setDescription([
              '**Quick Log:** `/p <reps>`, `/plank <seconds>`, `/run miles:<miles>`',
              '**General Log:** `/log type:<exercise> amount:<n>`',
              '**Profile:** `/profile`  •  **Inventory:** `/inventory`',
              '**Shop:** `/shop`, `/buy item:<name>`, `/equip item:<name>`',
              '**Pets/Mounts:** `/summonpet`, `/equipmount`',
              '**Hunts:** `/hunt create size:<1–5> exercise:<type>` → `/hunt join` → log matching exercise *in this channel*',
              '**Raids:** `/raid create exercise:<type> [hours] [hp] [name]` → logs auto-update the raid message',
              '**Adventure:** `/adventure` (spend 1 token for loot & XP)',
              '**Daily:** `/daily show` → `/daily claim`',
              '**Bounty:** `/bounty show` → `/bounty claim`',
              '**Art:** `/setart key:"Item or Boss Name" image:<upload>`'
            ].join('\n'));
          return interaction.reply({ embeds:[emb], ephemeral:true });
        }

        case 'profile': {
          const bar = xpBar(user);
          const emb = new EmbedBuilder()
            .setTitle(`🧑‍🚀 ${interaction.user.username}`)
            .setColor(0x1abc9c)
            .setDescription([
              `Level **${bar.lvl}**`,
              `XP ${bar.prog}/${bar.need}  (${bar.pct}%)`,
              `${bar.bar}`,
              `Coins **${user.coins}**  • Tokens **${user.tokens}**`,
              `Weapon: ${user.equipped.weapon||'—'} • Armor: ${user.equipped.armor||'—'} • Trinket: ${user.equipped.trinket||'—'}`,
              `Pet: ${user.equipped.pet||'—'} • Mount: ${user.equipped.mount||'—'}`
            ].join('\n'))
            .setThumbnail(interaction.user.displayAvatarURL());
          return interaction.reply({ embeds:[emb] });
        }

        case 'inventory': {
          const inv = user.inventory.length ? user.inventory.join(', ') : '—';
          const emb = new EmbedBuilder().setTitle('🎒 Inventory').setColor(0x7289da).setDescription(inv);
          return interaction.reply({ embeds:[emb], ephemeral:true });
        }

        case 'log': {
          const type = interaction.options.getString('type');
          const amount = interaction.options.getInteger('amount');
          return doWorkoutLog(interaction, type, amount);
        }

        case 'p': {
          const amount = interaction.options.getInteger('amount');
          return doWorkoutLog(interaction, 'pushups', amount);
        }

        case 'plank': {
          const amount = interaction.options.getInteger('amount');
          return doWorkoutLog(interaction, 'plank', amount);
        }

        case 'run': {
          const miles = interaction.options.getNumber('miles');
          return doWorkoutLog(interaction, 'run_miles', Math.round(miles));
        }

        case 'shop': {
          const reqPage = interaction.options.getInteger('page') || 1;
          const { emb, page, totalPages } = shopEmbed(reqPage);
          const prev = new ButtonBuilder().setCustomId(`shop:prev:${page}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page<=1);
          const next = new ButtonBuilder().setCustomId(`shop:next:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages);
          const row = new ActionRowBuilder().addComponents(prev, next);
          return interaction.reply({ embeds:[emb], components:[row] });
        }

        case 'buy': {
          const name = interaction.options.getString('item');
          const item = store.shop.items.find(i=>i.name.toLowerCase()===name.toLowerCase());
          if (!item) return interaction.reply({ content:'❌ Item not found.', ephemeral:true });
          if (user.coins < item.price) return interaction.reply({ content:`❌ Need ${item.price} coins.`, ephemeral:true });
          if ((item.type==='weapon'||item.type==='armor')){
            const lvl = levelFromXp(user.xp);
            if ((item.tier||1) > maxTierForLevel(lvl)){
              return interaction.reply({ content:`❌ Tier too high. Need higher level for **T${item.tier}**.`, ephemeral:true });
            }
          }
          user.coins -= item.price; user.inventory.push(item.name); saveSoon();
          showcaseItem(interaction.channel, interaction.user.id, item.name, '🛍️ Purchase');
          return;
        }

        case 'equip': {
          const name = interaction.options.getString('item');
          if (!user.inventory.includes(name)) return interaction.reply({ content:'❌ You do not own that item.', ephemeral:true });
          const item = store.shop.items.find(i=>i.name===name);
          if (!item || !['weapon','armor','trinket'].includes(item.type)) return interaction.reply({ content:'❌ Not equippable as gear.', ephemeral:true });
          user.equipped[item.type] = name; saveSoon();

          const url = artURL(item.name);
          const emb = new EmbedBuilder().setTitle('🛡️ Equipped').setColor(0x00c2ff)
            .setDescription(`You equipped **${item.name}**${item.tier?` (T${item.tier})`:''}.`);
          if (url) emb.setImage(url);
          return interaction.reply({ embeds:[emb] });
        }

        case 'summonpet': {
          const name = interaction.options.getString('item');
          if(!user.inventory.includes(name)) return interaction.reply({ content:'❌ You don’t own that pet.', ephemeral:true });
          const item = store.shop.items.find(i=>i.name===name);
          if (!item || item.type!=='pet') return interaction.reply({ content:'❌ That’s not a pet.', ephemeral:true });
          user.equipped.pet = name; saveSoon();
          const url = artURL(name);
          const emb = new EmbedBuilder().setTitle('🐾 Pet equipped!').setColor(0x00c2ff).setDescription(`**${name}** is now active!`);
          if (url) emb.setImage(url);
          return interaction.reply({ embeds:[emb] });
        }

        case 'equipmount': {
          const name = interaction.options.getString('item');
          if(!user.inventory.includes(name)) return interaction.reply({ content:'❌ You don’t own that mount.', ephemeral:true });
          const item = store.shop.items.find(i=>i.name===name);
          if (!item || item.type!=='mount') return interaction.reply({ content:'❌ That’s not a mount.', ephemeral:true });
          user.equipped.mount = name; saveSoon();
          const url = artURL(name);
          const emb = new EmbedBuilder().setTitle('🐎 Mount equipped!').setColor(0x00c2ff).setDescription(`**${name}** saddled up!`);
          if (url) emb.setImage(url);
          return interaction.reply({ embeds:[emb] });
        }

        case 'setart': {
          if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content:'Admin only.', ephemeral:true });
          const key = interaction.options.getString('key');
          const att = interaction.options.getAttachment('image');
          if (!att?.url) return interaction.reply({ content:'No image URL.', ephemeral:true });
          store.artMap[key] = att.url;
          store.artMap[key.toLowerCase()] = att.url;
          store.artMap[key.replace(/\s+/g,'_').toLowerCase()] = att.url;
          saveSoon();
          return interaction.reply(`✅ Art set for **${key}**`);
        }

        case 'daily': {
          const sub = interaction.options.getSubcommand();
          const d = ensureDaily();
          if (sub==='show') return interaction.reply({ embeds:[dailyEmbed()] });
          if (sub==='claim'){
            if (user.dailyProgress[`daily_${d.date}`]) return interaction.reply({ content:'✅ Already claimed today.', ephemeral:true });
            const totalXp = d.tasks.reduce((a,t)=>a+t.xp,0);
            const totalCoins = d.tasks.reduce((a,t)=>a+t.coins,0);
            user.xp += totalXp; user.coins += totalCoins;
            user.dailyProgress[`daily_${d.date}`] = true; saveSoon();
            return interaction.reply(`📆 Daily complete! +${totalXp} XP, +${totalCoins} coins`);
          }
          break;
        }

        case 'bounty': {
          const sub = interaction.options.getSubcommand();
          const b = ensureDailyBounty();
          if (sub==='show') return interaction.reply({ embeds:[bountyEmbed()] });
          if (sub==='claim'){
            if (user.dailyProgress[`bounty_${b.date}`]) return interaction.reply({ content:'✅ Already claimed today.', ephemeral:true });
            const xp = b.tasks.reduce((a,t)=>a+t.rewardXp,0);
            const coins = b.tasks.reduce((a,t)=>a+t.rewardCoins,0);
            user.xp += xp; user.coins += coins;
            user.dailyProgress[`bounty_${b.date}`] = true; saveSoon();
            return interaction.reply(`🎯 Bounty complete! +${xp} XP, +${coins} coins`);
          }
          break;
        }

        case 'hunt': {
          const sub = interaction.options.getSubcommand();
          const ch = interaction.channel;
          if (sub==='create'){
            const size = interaction.options.getInteger('size');
            const exercise = interaction.options.getString('exercise');
            if (getActiveHunt(ch.id)) return interaction.reply({ content:'⚠️ A hunt is already active here.', ephemeral:true });
            openHunt(ch.id, size, exercise, interaction.user.id);
            saveSoon();
            return interaction.reply({ embeds:[huntStatusEmbed(ch)] });
          }
          if (sub==='join'){
            const h = getActiveHunt(ch.id);
            if (!h) return interaction.reply({ content:'❌ No active hunt in this channel. Use `/hunt create`.', ephemeral:true });
            if ((user.tokens||0) <= 0) return interaction.reply({ content:'⚠️ You need 1 token to join. Log a workout to earn tokens.', ephemeral:true });
            const { error, joined } = joinHunt(ch.id, interaction.user.id);
            if (error) return interaction.reply({ content:`❌ ${error}`, ephemeral:true });
            if (joined) { user.tokens -= 1; saveSoon(); }
            return interaction.reply({ embeds:[huntStatusEmbed(ch)] });
          }
          if (sub==='status') return interaction.reply({ embeds:[huntStatusEmbed(interaction.channel)] });
          if (sub==='leave'){
            const { error } = leaveHunt(ch.id, interaction.user.id);
            if (error) return interaction.reply({ content:`❌ ${error}`, ephemeral:true });
            return interaction.reply({ content:'✅ You left the hunt.' });
          }
          if (sub==='cancel'){
            if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content:'Admin only.', ephemeral:true });
            if (!getActiveHunt(ch.id)) return interaction.reply({ content:'No active hunt.', ephemeral:true });
            delete store.hunts[ch.id]; saveSoon();
            return interaction.reply('🛑 Hunt cancelled.');
          }
          break;
        }

        case 'raid': {
          const sub = interaction.options.getSubcommand();
          const ch = interaction.channel;
          if (sub==='create'){
            if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content:'Admin only.', ephemeral:true });
            if (store.raids[ch.id]) return interaction.reply({ content:'⚠️ A raid is already active here.', ephemeral:true });
            const exercise = interaction.options.getString('exercise');
            const hp = interaction.options.getInteger('hp') || bossHpDefault(exercise);
            const hours = interaction.options.getInteger('hours') || 24;
            const name = interaction.options.getString('name') || bossNameForExercise(exercise);
            store.raids[ch.id] = {
              theme: EXERCISE_THEMES[exercise].label,
              exercise,
              unit: EXERCISE_THEMES[exercise].unit,
              bossName: name,
              hp: hp, hpMax: hp,
              deadline: Date.now() + hours*3600*1000,
              startedBy: interaction.user.id,
              participants: {},
              done:false,
              messageId:null
            };
            saveSoon();
            await interaction.reply({ content:'🛡️ Raid started! Posting status…' });
            await postOrUpdateRaidMessage(ch);
            return;
          }
          if (sub==='status') {
            await postOrUpdateRaidMessage(ch);
            return interaction.reply({ content:'📡 Raid status updated.', ephemeral:true });
          }
          if (sub==='cancel'){
            if(!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content:'Admin only.', ephemeral:true });
            if (!store.raids[ch.id]) return interaction.reply({ content:'No active raid.', ephemeral:true });
            delete store.raids[ch.id]; saveSoon();
            return interaction.reply('🛑 Raid cancelled.');
          }
          break;
        }

        case 'adventure': {
          return doAdventure(interaction);
        }

        default: return;
      }
    }

    // Shop pagination buttons
    if (interaction.isButton() && interaction.customId.startsWith('shop:')) {
      const parts = interaction.customId.split(':'); // ['shop','prev|next', currentPage]
      const dir = parts[1];
      const cur = parseInt(parts[2]||'1',10);
      const newPage = dir==='prev' ? Math.max(1, cur-1) : cur+1;

      const { emb, page, totalPages } = shopEmbed(newPage);
      const prev = new ButtonBuilder().setCustomId(`shop:prev:${page}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page<=1);
      const next = new ButtonBuilder().setCustomId(`shop:next:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages);
      const row = new ActionRowBuilder().addComponents(prev, next);
      return interaction.update({ embeds:[emb], components:[row] });
    }
  } catch (err){
    console.error('INTERACTION_ERROR', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content:'⚠️ Something went wrong.', ephemeral:true }); } catch {}
    }
  }
});

/* ---------------- Daily auto-post loop (00:01 America/Chicago) ---------------- */
setInterval(async () => {
  try {
    const tz = store.config.dailyPost.tz || 'America/Chicago';
    const now = getNowInTZ(tz);
    const h = now.getHours(), m = now.getMinutes();
    if (h === (store.config.dailyPost.hour ?? 0) && m === (store.config.dailyPost.minute ?? 1)) {
      const emb = dailyEmbed();
      ensureDailyBounty();
      const chId = store.config.dailyChannelId || DAILY_CHANNEL_ID;
      if (chId){
        const ch = await client.channels.fetch(chId).catch(()=>null);
        if (ch) ch.send({ content:'🗓️ **Daily Challenge**', embeds:[emb] }).catch(()=>{});
      }
      await new Promise(r=>setTimeout(r, 61000)); // prevent double-post within the minute
    }
  } catch(e){ console.warn('Daily loop error', e); }
}, 30 * 1000);

/* ---------------- Init ---------------- */
client.once('ready', async () => {
  console.log('🤖 Logged in as ' + client.user.tag);
  await loadStore().catch(console.error);
  console.log('✅ Global state loaded');
  await registerCommands().catch(console.error);
});
process.on('unhandledRejection', (e)=>{ console.error('UNHANDLED_REJECTION', e); });
process.on('uncaughtException', (e)=>{ console.error('UNCAUGHT_EXCEPTION', e); });
process.on('SIGTERM', ()=>{ saveStore().then(()=>process.exit(0)); });
process.on('SIGINT', ()=>{ saveStore().then(()=>process.exit(0)); });

(async function start(){
  if (!token || !clientId || !guildId){
    console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID env vars.');
  }
  if (USE_MONGO){
    await initMongo().catch(e=>console.error('Mongo init failed', e));
  }
  await client.login(token);
})();
