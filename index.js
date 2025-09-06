// FitRPG Bot — Mobile-first RPG Suite (FINAL • RELIABILITY EDITION)

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ActionRowBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http');
const path = require('path');

/* ---------------- Health server for Render ---------------- */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('FitRPG bot is running.\n');
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

/* ---------------- ENV ---------------- */
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId  = process.env.GUILD_ID;
if (!token || !clientId || !guildId) {
  console.error('❌ Missing env: DISCORD_TOKEN, CLIENT_ID, GUILD_ID required.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ---------------- Data persistence (Render Disk) ---------------- */
const DATA_FILE = process.env.DATA_PATH || path.join('/data', 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

let store = {
  users: {},
  shop: { items: [] },
  raids: { active: null },
  _todayDaily: null,
  _lastDailyKey: null,
  config: {
    levelRoles: [
      { level: 1,    roleName: 'Novice' },
      { level: 10,   roleName: 'Apprentice' },
      { level: 25,   roleName: 'Warrior' },
      { level: 50,   roleName: 'Champion' },
      { level: 100,  roleName: 'Legend' },
      { level: 200,  roleName: 'Mythic' },
      { level: 300,  roleName: 'Vanguard' },
      { level: 400,  roleName: 'Immortal' },
      { level: 500,  roleName: 'Titan' },
      { level: 650,  roleName: 'Eternal' },
      { level: 800,  roleName: 'Ascended' },
      { level: 1000, roleName: 'Transcendent' }
    ],
    levelUpChannelId: null,
    logCooldownSec: 10,
    adventureCooldownSec: 15,
    raidHitCooldownSec: 8,
    dailyChannelId: null,
    dailyPost: { hour: 0, minute: 1, tz:'America/Chicago' } // 00:01
  }
};
try {
  if (fs.existsSync(DATA_FILE)) {
    const disk = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    store = { ...store, ...disk };
  }
} catch(e){ console.error('DATA_LOAD_ERROR', e); }

/* ---------------- Save helpers ---------------- */
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function save() {
  try { atomicWrite(DATA_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('SAVE_ERROR', e); }
}
let _saveTimer=null;
function saveSoon(ms=300){ clearTimeout(_saveTimer); _saveTimer=setTimeout(save, ms); }

/* ---------------- Utility ---------------- */
function norm(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,'_'); }
function R(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function getNowInTZ(tz) { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); }

/* ---------------- Users ---------------- */
function ensureUser(id){
  if(!store.users[id]) store.users[id] = {
    xp:0, coins:0, tokens:0,
    inventory:[], equipped:{weapon:null,armor:null,trinket:null,cosmetic:null},
    lastLog:0, lastAdventure:0, lastRaidHit:0, lastActiveISO:null, streak:0,
    dailyProgress: {}, _buffs:{}
  };
  return store.users[id];
}

/* ---------------- XP Model ---------------- */
const BUILT_INS = {
  pushups:{ unit:'reps', rate:0.50 }, pullups:{ unit:'reps', rate:2.00 },
  situps:{ unit:'reps', rate:0.40 }, squats:{ unit:'reps', rate:0.40 },
  lunges:{ unit:'reps', rate:0.45 }, burpees:{ unit:'reps', rate:1.20 },
  dips:{ unit:'reps', rate:1.60 },
  plank:{ unit:'seconds', rate:0.20 },
  run_miles:{ unit:'miles', rate:40 }
};
function xpToNextLevel(n){ return Math.floor(25 + 1.3*(n+1) + 0.16*Math.pow(n+1,1.05)); }
function levelFromXp(xp){
  let lvl=0,total=0;
  while(xp >= (total += xpToNextLevel(lvl))) lvl++;
  return lvl;
}
function beginnerBoost(level){ return (level < 10) ? 1.5 : 1.0; }
function streakBoost(user){ return 1 + Math.min(0.5, 0.10*Math.max(0,(user.streak||0)-1)); }

/* ---------------- Rate limiting ---------------- */
const lastCmdAt = new Map();
function rateLimit(interaction, ms=1500){
  const now=Date.now(), k=interaction.user.id;
  if((lastCmdAt.get(k)||0)+ms > now) return true;
  lastCmdAt.set(k, now); return false;
}

/* ---------------- Process error guards ---------------- */
process.on('unhandledRejection', (r)=>console.error('UNHANDLED', r));
process.on('uncaughtException', (e)=>{ console.error('UNCAUGHT', e); process.exit(1); });
/* ---------------- Shop (expanded, paged) ---------------- */
function buildShopItems(){
  const items = [];

  // ---- WEAPONS (tiers 1–5) ----
  const weapons = [
    // T1
    { name:'Stick', atk:1, price:50, tier:1 },
    { name:'Wooden Sword', atk:2, price:120, tier:1 },
    { name:'Rusty Dagger', atk:2, price:150, tier:1 },
    // T2
    { name:'Iron Sword', atk:4, price:300, tier:2 },
    { name:'Spear', atk:5, price:350, tier:2 },
    { name:'Hunting Bow', atk:5, price:400, tier:2 },
    // T3
    { name:'Steel Axe', atk:8, price:650, tier:3 },
    { name:'Warhammer', atk:9, price:750, tier:3 },
    { name:'Longbow', atk:9, price:800, tier:3 },
    // T4
    { name:'Flamebrand', atk:14, price:1200, tier:4 },
    { name:'Storm Spear', atk:15, price:1400, tier:4 },
    { name:'Runed Blade', atk:16, price:1600, tier:4 },
    // T5
    { name:'Dragon Slayer', atk:25, price:2200, tier:5 },
    { name:'Celestial Halberd', atk:28, price:2500, tier:5 },
  ].map(w => ({ type:'weapon', ...w }));

  // ---- ARMOR (tiers 1–5) ----
  const armors = [
    // T1
    { name:'Cloth Tunic', def:1, price:80, tier:1 },
    { name:'Padded Vest', def:2, price:120, tier:1 },
    // T2
    { name:'Leather Armor', def:4, price:300, tier:2 },
    { name:'Chainmail', def:5, price:400, tier:2 },
    // T3
    { name:'Scale Armor', def:8, price:650, tier:3 },
    { name:'Half-Plate', def:9, price:750, tier:3 },
    // T4
    { name:'Full Plate', def:14, price:1200, tier:4 },
    { name:'Dragonhide', def:15, price:1400, tier:4 },
    // T5
    { name:'Celestial Plate', def:22, price:2200, tier:5 },
    { name:'Voidforged Mail', def:25, price:2500, tier:5 },
  ].map(a => ({ type:'armor', ...a }));

  // ---- TRINKETS (rare) ----
  const trinkets = [
    { name:'Lucky Coin', bonus:'+5% coin gain', price:1500, tier:4 },
    { name:'Runner’s Band', bonus:'+5% run XP', price:1600, tier:4 },
    { name:'Iron Amulet', bonus:'+5% strength XP', price:1700, tier:4 },
    { name:'Phoenix Feather', bonus:'1 auto-res in raid', price:2500, tier:5 },
  ].map(t => ({ type:'trinket', ...t }));

  // ---- CONSUMABLES ----
  const consumables = [
    { name:'Health Potion', effect:'restore raid hp', price:50 },
    { name:'Energy Drink', effect:'double XP for next log', price:150 },
    { name:'Treasure Map', effect:'guaranteed loot on next adventure', price:200 },
    { name:'Stamina Brew', effect:'+1 adventure token', price:250 },
  ].map(c => ({ type:'consumable', ...c }));

  items.push(...weapons, ...armors, ...trinkets, ...consumables);
  return items;
}
store.shop.items = store.shop.items?.length ? store.shop.items : buildShopItems();

function shopEmbed(page=0){
  const perPage=8;
  const totalPages = Math.max(1, Math.ceil(store.shop.items.length/perPage));
  const p = Math.min(Math.max(0, page), totalPages-1);
  const items = store.shop.items.slice(p*perPage,(p+1)*perPage);
  return new EmbedBuilder()
    .setTitle(`🛒 Shop — Page ${p+1}/${totalPages}`)
    .setColor(0x00C2FF)
    .setDescription(items.map(i=>{
      const stats = i.type==='weapon' ? `ATK ${i.atk}` :
                    i.type==='armor'  ? `DEF ${i.def}` :
                    i.type==='trinket'? i.bonus : i.effect;
      const tier = i.tier ? `T${i.tier}` : '—';
      return `• **${i.name}** — ${i.price} coins 〔${i.type}, ${tier}${stats?`, ${stats}`:''}〕`;
    }).join('\n') || '_No items_');
}

/* ---------------- Adventures (stamina-gated, loot-first) ---------------- */
function adventure(user){
  const now = Date.now();
  if(now - user.lastAdventure < (store.config.adventureCooldownSec||15)*1000){
    const wait = Math.ceil(((store.config.adventureCooldownSec*1000)-(now-user.lastAdventure))/1000);
    return { fail:`⏳ Adventure on cooldown. Try again in ${wait}s.` };
  }
  if(user.tokens<=0) return { fail:'⚠️ You need an Adventure Token. Log workouts to earn tokens.' };

  user.tokens -= 1;
  user.lastAdventure = now;

  // Loot table:
  // 55% coins chest, 25% gear, 15% “event text”, 4% consumable bundle, 1% rare trinket
  const roll = R(1,100);
  if(roll<=55){
    const coins = R(40,100);
    user.coins += coins;
    return { msg:`💰 You found a chest with **${coins}** coins!` };
  } else if(roll<=80){
    // gear from shop (weapon/armor favored)
    const gearPool = store.shop.items.filter(i=>i.type==='weapon'||i.type==='armor');
    const item = gearPool[R(0,gearPool.length-1)];
    user.inventory.push(item.name);
    return { msg:`🧰 You discovered **${item.name}**!` };
  } else if(roll<=95){
    // flavorful encounter (no direct reward)
    const texts = [
      'A shadow passes overhead. You brace… nothing happens.',
      'You stumble upon old ruins—mysterious, but empty.',
      'A traveling merchant waves. Prices seem… unreasonable.',
      'A flock of sprites giggle and vanish into the trees.'
    ];
    return { msg:`🗺️ ${texts[R(0,texts.length-1)]}` };
  } else if(roll<=99){
    // consumable bundle
    const bundle = ['Health Potion','Energy Drink','Treasure Map'];
    const count = R(2,3);
    for(let i=0;i<count;i++) user.inventory.push(bundle[R(0,bundle.length-1)]);
    return { msg:`🎁 You found a supply stash! Gained **${count}** random consumables.` };
  } else {
    // ultra-rare trinket
    const trinks = store.shop.items.filter(i=>i.type==='trinket');
    const t = trinks[R(0,trinks.length-1)];
    user.inventory.push(t.name);
    return { msg:`✨ RARE FIND! You obtained **${t.name}**!` };
  }
}

/* ---------------- Dailies (themes + rewards) ---------------- */
function randPick(a){ return a[Math.floor(Math.random()*a.length)]; }
function rangePick(min,max,step=1){ const n = Math.floor((max-min)/step)+1; return min + step*Math.floor(Math.random()*n); }

function generateDailyTheme() {
  // rotate predictably by weekday to keep variety consistent across months
  const day = getNowInTZ(store.config.dailyPost.tz).getDay(); // 0=Sun..6=Sat
  const order = ['mixed','upper','legs','core','run','upper','mixed'];
  return order[day];
}

function buildTasksForTheme(theme) {
  // bodyweight/run only for accessibility
  if (theme === 'upper') {
    return [
      { type:'pushups', desc:'Pushups', unit:'reps', target: rangePick(80,120,10), rewardXp: R(110,160), rewardCoins: R(65,95) },
      { type:'pullups', desc:'Pullups', unit:'reps', target: rangePick(10,20,2), rewardXp: R(100,140), rewardCoins: R(60,90) }
    ];
  }
  if (theme === 'legs') {
    return [
      { type:'squats', desc:'Bodyweight Squats', unit:'reps', target: rangePick(120,200,20), rewardXp: R(120,170), rewardCoins: R(70,100) },
      { type:'lunges', desc:'Lunges', unit:'reps', target: rangePick(60,120,10), rewardXp: R(100,150), rewardCoins: R(60,95) }
    ];
  }
  if (theme === 'core') {
    return [
      { type:'plank', desc:'Plank Hold', unit:'seconds', target: rangePick(150,240,30), rewardXp: R(120,170), rewardCoins: R(70,100) },
      { type:'situps', desc:'Situps', unit:'reps', target: rangePick(80,140,10), rewardXp: R(100,140), rewardCoins: R(60,90) }
    ];
  }
  if (theme === 'run') {
    return [
      { type:'run_miles', desc:'Run Distance', unit:'miles', target: rangePick(2,3,1), rewardXp: R(140,190), rewardCoins: R(80,110) }
    ];
  }
  // mixed day: 3 tasks
  return [
    { type:'pushups', desc:'Pushups', unit:'reps', target: rangePick(60,100,10), rewardXp: R(100,145), rewardCoins: R(60,90) },
    { type:'plank', desc:'Plank Hold', unit:'seconds', target: rangePick(120,180,30), rewardXp: R(110,150), rewardCoins: R(65,95) },
    { type:'run_miles', desc:'Run Distance', unit:'miles', target: 2, rewardXp: R(140,180), rewardCoins: R(80,105) }
  ];
}

function ensureTodayDaily(){
  const today = todayISO();
  if (store._todayDaily && store._todayDaily.date === today) return store._todayDaily;
  const theme = generateDailyTheme();
  const tasks = buildTasksForTheme(theme);
  store._todayDaily = { date: today, theme, tasks };
  saveSoon();
  return store._todayDaily;
}

function dailyPreviewEmbed(){
  const d = ensureTodayDaily();
  const lines = d.tasks.map(t => `• **${t.desc}** — ${t.target} ${t.unit} 〔+${t.rewardXp} XP, +${t.rewardCoins} coins〕`);
  return new EmbedBuilder()
    .setTitle(`📅 Daily Challenge — ${d.date} • Theme: ${d.theme.toUpperCase()}`)
    .setColor(0xFFD700)
    .setDescription(lines.join('\n'))
    .setFooter({ text:'Log as usual (/p, /plank, /runmiles). When done, use /daily claim.' });
}

/* ---------------- Daily Auto-Post Scheduler (00:01 CT) ---------------- */
function dailyKey(dateISO, hour, minute){ return `${dateISO}_${hour}:${minute}`; }

async function postDailyChallenge(){
  const d = ensureTodayDaily();
  if(store.config.dailyChannelId){
    try{
      const ch = await client.channels.fetch(store.config.dailyChannelId);
      if (ch) await ch.send({ embeds:[dailyPreviewEmbed()] });
    }catch(e){ console.error('DAILY_POST_ERROR', e); }
  }
  // snapshot backup once a day after posting
  try { save(); backup(); } catch(e){ console.error('POST_SAVE_BACKUP_ERR', e); }
}

function startDailyScheduler(){
  setInterval(async ()=>{
    try{
      const { hour, minute, tz } = store.config.dailyPost || { hour:0, minute:1, tz:'America/Chicago' };
      const now = getNowInTZ(tz);
      const key = dailyKey(todayISO(), hour, minute);
      if (now.getHours()===hour && now.getMinutes()===minute) {
        if (store._lastDailyKey !== key) {
          store._lastDailyKey = key;
          saveSoon();
          await postDailyChallenge();
        }
      }
    }catch(e){ console.error('DAILY_SCHED_ERROR', e); }
  }, 30*1000); // check twice a minute
}
/* ---------------- Command Registry ---------------- */
const commands = [
  new SlashCommandBuilder().setName('p').setDescription('Log pushups')
    .addIntegerOption(o=>o.setName('amount').setDescription('Reps').setRequired(true)),

  new SlashCommandBuilder().setName('plank').setDescription('Log plank (seconds)')
    .addIntegerOption(o=>o.setName('seconds').setDescription('Seconds').setRequired(true)),

  new SlashCommandBuilder().setName('runmiles').setDescription('Log run (miles)')
    .addNumberOption(o=>o.setName('miles').setDescription('Miles').setRequired(true)),

  new SlashCommandBuilder().setName('log').setDescription('Log any workout')
    .addStringOption(o=>o.setName('type').setDescription('Exercise type').setRequired(true))
    .addNumberOption(o=>o.setName('amount').setDescription('Reps/seconds/miles').setRequired(true)),

  new SlashCommandBuilder().setName('quicklog').setDescription('Menu for common logs'),

  new SlashCommandBuilder().setName('adventure').setDescription('Spend a token to adventure'),

  new SlashCommandBuilder().setName('shop').setDescription('View shop')
    .addIntegerOption(o=>o.setName('page').setDescription('Page number')),

  new SlashCommandBuilder().setName('buy').setDescription('Buy from shop')
    .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true)),

  new SlashCommandBuilder().setName('inventory').setDescription('Show your inventory'),

  new SlashCommandBuilder().setName('equip').setDescription('Equip gear')
    .addStringOption(o=>o.setName('item').setDescription('Item name').setRequired(true)),

  new SlashCommandBuilder().setName('gear').setDescription('Show equipped gear'),

  new SlashCommandBuilder().setName('daily').setDescription('Daily challenge')
    .addSubcommand(s=>s.setName('show').setDescription('Show today\'s daily'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim rewards if complete')),

  new SlashCommandBuilder().setName('raid').setDescription('Raid commands')
    .addSubcommand(s=>s.setName('start').setDescription('Start a raid boss'))
    .addSubcommand(s=>s.setName('join').setDescription('Join the active raid'))
    .addSubcommand(s=>s.setName('attack').setDescription('Attack the boss'))
    .addSubcommand(s=>s.setName('status').setDescription('Show raid status')),

  new SlashCommandBuilder().setName('profile').setDescription('View your profile'),

  new SlashCommandBuilder().setName('setdailychannel').setDescription('Set daily challenge channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('setlevelupchannel').setDescription('Set level-up announcements channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

/* ---------------- Command Handling ---------------- */
client.on('interactionCreate', async interaction => {
  if(!interaction.isChatInputCommand()) return;
  if(rateLimit(interaction)) return interaction.reply({ content:'⏳ Slow down…', ephemeral:true });

  const user = ensureUser(interaction.user.id);

  try {
    switch(interaction.commandName){

      /* Workout logs */
      case 'p': {
        const reps = interaction.options.getInteger('amount');
        const xp = reps*BUILT_INS.pushups.rate;
        handleLog(interaction, user, 'pushups', reps, xp);
        break;
      }
      case 'plank': {
        const secs = interaction.options.getInteger('seconds');
        const xp = secs*BUILT_INS.plank.rate;
        handleLog(interaction, user, 'plank', secs, xp);
        break;
      }
      case 'runmiles': {
        const miles = interaction.options.getNumber('miles');
        const xp = miles*BUILT_INS.run_miles.rate;
        handleLog(interaction, user, 'run_miles', miles, xp);
        break;
      }
      case 'log': {
        const type = norm(interaction.options.getString('type'));
        const amt = interaction.options.getNumber('amount');
        const def = BUILT_INS[type];
        if(!def) return interaction.reply({ content:`⚠️ Unknown type: ${type}`, ephemeral:true });
        const xp = def.rate*amt;
        handleLog(interaction, user, type, amt, xp);
        break;
      }
      case 'quicklog': {
        const menu = new StringSelectMenuBuilder()
          .setCustomId('ql')
          .setPlaceholder('Choose workout')
          .addOptions([
            { label:'Pushups 50', value:'p:50' },
            { label:'Pushups 100', value:'p:100' },
            { label:'Plank 120s', value:'plank:120' },
            { label:'Run 2 miles', value:'runmiles:2' }
          ]);
        const row = new ActionRowBuilder().addComponents(menu);
        return interaction.reply({ content:'QuickLog:', components:[row], ephemeral:true });
      }

      /* Adventures */
      case 'adventure': {
        const res = adventure(user);
        if(res.fail) return interaction.reply({ content:res.fail, ephemeral:true });
        saveSoon();
        return interaction.reply(res.msg);
      }

      /* Shop & buy */
      case 'shop': {
        const page = interaction.options.getInteger('page')||0;
        return interaction.reply({ embeds:[shopEmbed(page)] });
      }
      case 'buy': {
        const name = interaction.options.getString('item');
        const item = store.shop.items.find(i=>i.name.toLowerCase()===name.toLowerCase());
        if(!item) return interaction.reply({ content:'❌ Item not found.', ephemeral:true });
        if(user.coins<item.price) return interaction.reply({ content:'💸 Not enough coins.', ephemeral:true });
        user.coins -= item.price;
        user.inventory.push(item.name);
        saveSoon();
        return interaction.reply(`✅ You bought **${item.name}**!`);
      }

      /* Inventory & gear */
      case 'inventory': {
        return interaction.reply(`🎒 Inventory: ${user.inventory.join(', ')||'Empty'}`);
      }
      case 'equip': {
        const name = interaction.options.getString('item');
        if(!user.inventory.includes(name)) return interaction.reply({ content:'❌ You don\'t own that.', ephemeral:true });
        if(name.toLowerCase().includes('sword')||name.toLowerCase().includes('axe')||name.toLowerCase().includes('bow')) user.equipped.weapon=name;
        else if(name.toLowerCase().includes('armor')||name.toLowerCase().includes('plate')||name.toLowerCase().includes('mail')) user.equipped.armor=name;
        else if(name.toLowerCase().includes('coin')||name.toLowerCase().includes('band')||name.toLowerCase().includes('amulet')||name.toLowerCase().includes('feather')) user.equipped.trinket=name;
        saveSoon();
        return interaction.reply(`✅ Equipped ${name}`);
      }
      case 'gear': {
        const eq=user.equipped;
        return interaction.reply(`⚔️ Weapon: ${eq.weapon||'—'}\n🛡 Armor: ${eq.armor||'—'}\n✨ Trinket: ${eq.trinket||'—'}`);
      }

      /* Daily */
      case 'daily': {
        const sub = interaction.options.getSubcommand();
        if(sub==='show') return interaction.reply({ embeds:[dailyPreviewEmbed()] });
        if(sub==='claim'){
          const d=ensureTodayDaily();
          // mark complete (for simplicity, claim always works once/day)
          if(user.dailyProgress[d.date]?.claimed) return interaction.reply({ content:'✅ Already claimed.', ephemeral:true });
          const xp=d.tasks.reduce((a,t)=>a+t.rewardXp,0);
          const coins=d.tasks.reduce((a,t)=>a+t.rewardCoins,0);
          user.xp+=xp; user.coins+=coins;
          user.dailyProgress[d.date]={claimed:true};
          saveSoon();
          return interaction.reply(`🎉 Daily complete! +${xp} XP, +${coins} coins`);
        }
        break;
      }

      /* Raids (simple placeholder) */
      case 'raid': {
        const sub=interaction.options.getSubcommand();
        if(sub==='start'){
          store.raids.active={ hp:1000, joined:[interaction.user.id] };
          saveSoon();
          return interaction.reply('👹 A raid boss appears! Use /raid join or /raid attack.');
        }
        if(sub==='join'){
          if(!store.raids.active) return interaction.reply('❌ No active raid.');
          if(!store.raids.active.joined.includes(interaction.user.id)) store.raids.active.joined.push(interaction.user.id);
          saveSoon();
          return interaction.reply('✅ Joined the raid!');
        }
        if(sub==='attack'){
          if(!store.raids.active) return interaction.reply('❌ No active raid.');
          const dmg=R(20,50);
          store.raids.active.hp-=dmg;
          if(store.raids.active.hp<=0){
            store.raids.active=null;
            saveSoon();
            return interaction.reply(`⚔️ You dealt ${dmg} dmg and defeated the boss!`);
          }
          saveSoon();
          return interaction.reply(`⚔️ You hit the boss for ${dmg} dmg. HP left: ${store.raids.active.hp}`);
        }
        if(sub==='status'){
          if(!store.raids.active) return interaction.reply('❌ No active raid.');
          return interaction.reply(`👹 Boss HP: ${store.raids.active.hp}`);
        }
        break;
      }

      /* Profile */
      case 'profile': {
        const lvl=levelFromXp(user.xp);
        return interaction.reply(`👤 ${interaction.user.username}\nLvl ${lvl} (${user.xp} XP)\nCoins: ${user.coins}\nTokens: ${user.tokens}`);
      }

      /* Admin config */
      case 'setdailychannel': {
        store.config.dailyChannelId=interaction.channel.id;
        saveSoon();
        return interaction.reply(`✅ Daily channel set to ${interaction.channel.name}`);
      }
      case 'setlevelupchannel': {
        store.config.levelUpChannelId=interaction.channel.id;
        saveSoon();
        return interaction.reply(`✅ Level-up channel set to ${interaction.channel.name}`);
      }
    }
  } catch(e){
    console.error('CMD_ERROR', interaction.commandName, e);
    if(interaction.replied||interaction.deferred) interaction.followUp({ content:'⚠️ Error.', ephemeral:true });
    else interaction.reply({ content:'⚠️ Error.', ephemeral:true });
  }
});

/* Handle QuickLog menu */
client.on('interactionCreate', async i=>{
  if(!i.isStringSelectMenu()) return;
  if(i.customId==='ql'){
    const [cmd,val]=i.values[0].split(':');
    const fake = { commandName:cmd, options:{ getInteger:()=>parseInt(val), getNumber:()=>parseFloat(val) }, user:i.user, reply:(c)=>i.update(c) };
    // re-use the log handlers
    if(cmd==='p'){ const xp=val*BUILT_INS.pushups.rate; handleLog(fake, ensureUser(i.user.id), 'pushups', val, xp); }
    if(cmd==='plank'){ const xp=val*BUILT_INS.plank.rate; handleLog(fake, ensureUser(i.user.id), 'plank', val, xp); }
    if(cmd==='runmiles'){ const xp=val*BUILT_INS.run_miles.rate; handleLog(fake, ensureUser(i.user.id), 'run_miles', val, xp); }
  }
});
/* ---------------- Log handler (+ boosts, tokens, roles, ding) ---------------- */
async function handleLog(interaction, user, type, amount, baseXp){
  // Validation
  if (!Number.isFinite(amount) || amount<=0) {
    return interaction.reply({ content:'⚠️ Enter a positive number.', ephemeral:true });
  }

  // Cooldown (basic per-user)
  const now = Date.now();
  if (now - user.lastLog < (store.config.logCooldownSec||10)*1000) {
    const wait = Math.ceil(((store.config.logCooldownSec*1000)-(now-user.lastLog))/1000);
    return interaction.reply({ content:`⏳ Logging too fast. Try again in ${wait}s.`, ephemeral:true });
  }

  // Calculate XP with boosts
  const preLevel = levelFromXp(user.xp);
  let xpGain = baseXp;
  xpGain *= beginnerBoost(preLevel);
  xpGain *= streakBoost(user);
  xpGain = Math.round(xpGain);

  // Apply
  user.xp += xpGain;
  user.tokens += 1; // 1 token per log (stamina to adventure)
  user.lastLog = now;

  // Streak handling (simple: new day increases streak, missing a day resets)
  const today = todayISO();
  if (user.lastActiveISO !== today) {
    if (user.lastActiveISO === null) user.streak = 1;
    else {
      const last = new Date(user.lastActiveISO);
      const t = new Date(today);
      const diffDays = Math.round((t - last)/86400000);
      user.streak = (diffDays===1) ? (user.streak+1) : 1;
    }
    user.lastActiveISO = today;
  }

  saveSoon();

  // Level-up check
  const postLevel = levelFromXp(user.xp);
  let levelMsg = '';
  if (postLevel > preLevel) {
    levelMsg = await onLevelUp(interaction, interaction.user, user, preLevel, postLevel);
  }

  // Reply to user
  const pretty = `✅ Logged **${amount} ${type}** → +${xpGain} XP, +1 token (${user.tokens} tokens total)`;
  return interaction.reply(levelMsg ? `${pretty}\n${levelMsg}` : pretty);
}

/* ---------------- Level-ups: roles & announcement ---------------- */
async function onLevelUp(interaction, userObj, userData, oldLvl, newLvl){
  // Assign role rewards for milestones crossed
  const milestones = store.config.levelRoles || [];
  const guild = interaction.guild;
  let granted = [];

  if (guild) {
    const member = await guild.members.fetch(userObj.id).catch(()=>null);
    if (member) {
      for(const m of milestones){
        if (oldLvl < m.level && newLvl >= m.level) {
          const role = guild.roles.cache.find(r=>r.name===m.roleName);
          if (role) {
            await member.roles.add(role).catch(()=>{});
            granted.push(m.roleName);
          }
        }
      }
    }
  }

  // Announce in level-up channel (if configured) for milestone levels only
  const milestoneHit = milestones.find(m => m.level===newLvl);
  if (milestoneHit && store.config.levelUpChannelId) {
    try{
      const ch = await client.channels.fetch(store.config.levelUpChannelId).catch(()=>null);
      if (ch) {
        const emb = new EmbedBuilder()
          .setTitle('🎉 Level Up!')
          .setColor(0x7CFC00)
          .setDescription(`<@${userObj.id}> reached **Level ${newLvl}**!`)
          .setFooter({text: granted.length ? `New role: ${granted.join(', ')}` : 'Keep it up!'});
        ch.send({ embeds:[emb] }).catch(()=>{});
      }
    }catch(e){ /* ignore */ }
  }

  const roleText = granted.length ? ` • Awarded role: ${granted.join(', ')}` : '';
  return `🆙 **Level Up!** You are now **Level ${newLvl}**${roleText}`;
}

/* ---------------- Register slash commands & boot ---------------- */
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
      body: commands.map(c => c.toJSON())
    });
    console.log('✅ Commands registered');
  } catch (e) {
    console.error('REGISTER_CMDS_ERROR', e);
  }

  // Start daily scheduler
  startDailyScheduler();
});

/* ---------------- Login ---------------- */
client.login(token);
