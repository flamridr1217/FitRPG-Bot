// FitRPG Bot — Mobile-first RPG Suite
// QuickLog (buttons) • Shortcuts • Adventure • Raids (panel) • Shop/Gear/Trinkets
// Level-up rewards & embeds • Daily quests & streaks • Simple event scheduler (+reminders)
// Health server for Render (Web Service) • Level curve exponent 1.2
// Requires: discord.js ^14 (CommonJS)

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http');

/* ---------------- Health server for Render ---------------- */
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('FitRPG bot is running.\n');
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

/* ---------------- ENV ---------------- */
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID; // Application (Client) ID
const guildId  = process.env.GUILD_ID;  // Server (Guild) ID

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ---------------- Persistent store ---------------- */
const DATA_FILE = 'data.json';
let store = {
  users: {}, // id -> { xp, coins, inventory:[], equipped:{weapon:null,armor:null,trinket:null,cosmetic:null}, lastLog, lastAdventure, lastRaidHit, lastActiveISO, streak }
  customExercises: {},
  shop: { items: [] },
  raids: { active: null }, // { id, bossName, tier, maxHp, hp, endsAt, messageId, channelId, contributions:{uid:dmg}, joined:[] }
  events: [], // { id, title, at, channelId, remindMins:[...], createdBy }
  config: {
    levelRoles: [
      { level: 1,  roleName: 'Novice' },
      { level: 5,  roleName: 'Apprentice' },
      { level: 10, roleName: 'Warrior' },
      { level: 20, roleName: 'Champion' },
      { level: 40, roleName: 'Legend' }
    ],
    levelUpChannelId: null,
    logCooldownSec: 10,
    adventureCooldownSec: 15,
    raidHitCooldownSec: 8,
    timezoneNote: 'America/Chicago' // for /help display only
  }
};
if (fs.existsSync(DATA_FILE)) { try { store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) }; } catch {} }
function save(){ fs.writeFileSync(DATA_FILE, JSON.stringify(store,null,2)); }

/* ---------------- Exercises & XP ---------------- */
const BUILT_INS = {
  // bodyweight
  pushups:{ unit:'reps', rate:0.5 }, situps:{ unit:'reps', rate:0.5 }, squats:{ unit:'reps', rate:0.5 },
  lunges:{ unit:'reps', rate:0.6 }, burpees:{ unit:'reps', rate:1.0 }, pullups:{ unit:'reps', rate:1.5 }, dips:{ unit:'reps', rate:1.5 },
  // time
  plank:{ unit:'seconds', rate:0.2 },
  // cardio
  run_miles:{ unit:'miles', rate:20 }, run:{ unit:'minutes', rate:0.17 }, cycle_miles:{ unit:'miles', rate:8 },
  row_minutes:{ unit:'minutes', rate:0.25 }, swim_laps:{ unit:'laps', rate:15 },
  // weighted
  bench:{ unit:'weighted_reps', rateWeight:0.02 }, legpress:{ unit:'weighted_reps', rateWeight:0.02 },
  deadlift:{ unit:'weighted_reps', rateWeight:0.02 }, squat_barbell:{ unit:'weighted_reps', rateWeight:0.02 }, ohp:{ unit:'weighted_reps', rateWeight:0.02 },
  // sessions
  strengthsession:{ unit:'sessions', rate:25 }
};
const UNIT_DEFAULTS = { reps:0.5, seconds:0.2, minutes:0.2, miles:12, km:7.5, meters:0.012, laps:10, sessions:25 };
const MOBILE_EXERCISE_CHOICES = [
  { label:'Pushups', value:'pushups' }, { label:'Situps', value:'situps' }, { label:'Squats', value:'squats' },
  { label:'Plank (sec)', value:'plank' }, { label:'Pullups', value:'pullups' },
  { label:'Run (miles)', value:'run_miles' }, { label:'Bench (weighted)', value:'bench' }
];

function norm(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,'_'); }
function toLbs(weight, unit){ if(!weight||weight<=0) return 0; if(!unit||unit==='lb'||unit==='lbs') return weight; if(unit==='kg') return weight*2.2046226218; return weight; }

function computeXP({ exercise, amount, unit, weight, weightUnit }) {
  const key = norm(exercise);
  const cfg = BUILT_INS[key] || store.customExercises[key];
  if (cfg && cfg.unit === 'weighted_reps') {
    const reps = amount; const lbs = toLbs(weight||0, weightUnit);
    const xp = (cfg.rateWeight||0.02) * (lbs * reps);
    return { xp, basis:`weighted: ${reps} reps @ ${lbs.toFixed(1)} lb` };
  }
  const useUnit = unit || (cfg ? cfg.unit : null);
  const rate = (cfg && cfg.rate) ?? UNIT_DEFAULTS[useUnit || 'reps'];
  const xp = (amount||0) * (rate||0);
  return { xp, basis:`${amount} ${useUnit || (cfg ? cfg.unit : 'units')}` };
}

/* ---------------- Levels, multipliers, streaks & roles ---------------- */
// Softer curve for mobile: base 90, exponent 1.2
function levelFromXp(xp){
  xp = Number(xp||0); let lvl=0, rem=xp;
  while(true){ const need=Math.floor(90*Math.pow(lvl+1,1.2)); if(rem>=need){ rem-=need; lvl++; } else break; }
  return lvl;
}
function levelXpMultiplier(l){ if(l>=40) return 1.18; if(l>=25) return 1.12; if(l>=10) return 1.06; return 1.00; }
function levelCoinMultiplier(l){ if(l>=40) return 1.25; if(l>=25) return 1.15; if(l>=10) return 1.08; return 1.00; }
async function grantLevelRoles(guild, member, prev, now){
  for (const th of store.config.levelRoles) {
    if (prev < th.level && now >= th.level) {
      const role = guild.roles.cache.find(r => r.name === th.roleName);
      if (role) { try { await member.roles.add(role.id,'Level-up'); } catch(e){ console.warn('Role add:', e.message); } }
    }
  }
}
function ensureUser(id){
  if(!store.users[id]) store.users[id] = {
    xp:0, coins:0, inventory:[], equipped:{weapon:null,armor:null,trinket:null,cosmetic:null},
    lastLog:0, lastAdventure:0, lastRaidHit:0, lastActiveISO:null, streak:0, daily:null
  };
  return store.users[id];
}
function touchStreak(user){
  const today = new Date(); const dISO = today.toISOString().slice(0,10);
  if (user.lastActiveISO === dISO) return; // already counted today
  if (!user.lastActiveISO) { user.streak = 1; user.lastActiveISO = dISO; return; }
  const prev = new Date(user.lastActiveISO+'T00:00:00Z'); const diffDays = Math.round((today - prev)/86400000);
  if (diffDays === 1) user.streak += 1;
  else if (diffDays > 1) user.streak = 1;
  user.lastActiveISO = dISO;
}

/* ---------------- Shop inventory (expanded) ---------------- */
if(!store.shop.items || store.shop.items.length===0){
  store.shop.items = [
    // Weapons
    { key:'wooden_sword',  name:'Wooden Sword',  type:'weapon', power:2,  price:50,  desc:'Starter blade.' },
    { key:'iron_sword',    name:'Iron Sword',    type:'weapon', power:5,  price:150, desc:'Reliable steel.', levelReq:3 },
    { key:'war_hammer',    name:'War Hammer',    type:'weapon', power:9,  price:400, desc:'Bonk with style.', levelReq:7,  critChance:+0.03, critDamage:+0.25 },
    { key:'storm_blade',   name:'Storm Blade',   type:'weapon', power:12, price:650, desc:'Crackling edge.',  levelReq:10, critChance:+0.05, critDamage:+0.35 },
    { key:'dragon_lance',  name:'Dragon Lance',  type:'weapon', power:16, price:950, desc:'Legend-tier.',     levelReq:14, critChance:+0.06, critDamage:+0.45 },
    // Armor
    { key:'leather_armor', name:'Leather Armor', type:'armor',  power:2,  price:120, desc:'Light defense.' },
    { key:'chainmail',     name:'Chainmail',     type:'armor',  power:4,  price:260, desc:'Solid protection.', levelReq:4,  block:+0.03 },
    { key:'plate_armor',   name:'Plate Armor',   type:'armor',  power:7,  price:600, desc:'Heavy duty.',       levelReq:10, block:+0.06 },
    { key:'aegis_mail',    name:'Aegis Mail',    type:'armor',  power:10, price:900, desc:'Guardian steel.',   levelReq:14, block:+0.08 },
    // Trinkets
    { key:'runner_band',   name:'Runner’s Band',   type:'trinket', price:180, desc:'You feel swift.',  xpMult:+0.05 },
    { key:'merchant_coin', name:'Merchant’s Coin', type:'trinket', price:240, desc:'Coins find you.',  coinMult:+0.10 },
    { key:'lucky_charm',   name:'Lucky Charm',     type:'trinket', price:320, desc:'A little luck.',  critChance:+0.04 },
    // Cosmetics/Titles
    { key:'color_royal',   name:'Royal Color',   type:'cosmetic', price:120, desc:'Royal flair.', roleReward:'Royal' },
    { key:'title_champion',name:'Title: Champion', type:'cosmetic', price:300, desc:'Show your title.', roleReward:'Title: Champion' }
  ];
  save();
}

/* ---------------- Monsters & raids ---------------- */
const MONSTERS = [
  { key:'slime',  name:'Training Slime',  tier:1, hp:[20,30],  atk:[2,4],   coin:[12,22],  xp:[20,35]  },
  { key:'boar',   name:'Wild Boar',       tier:2, hp:[35,55],  atk:[4,7],   coin:[22,35],  xp:[35,55]  },
  { key:'bandit', name:'Roadside Bandit', tier:3, hp:[55,80],  atk:[6,10],  coin:[35,55],  xp:[55,85]  },
  { key:'golem',  name:'Stone Golem',     tier:4, hp:[85,120], atk:[8,14],  coin:[55,90],  xp:[85,130] },
  { key:'wyvern', name:'Cliff Wyvern',    tier:5, hp:[125,170],atk:[12,18], coin:[90,150], xp:[130,200] }
];
function R(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function pickMonster(level){
  const idx=Math.min(MONSTERS.length-1, Math.floor(level/7));
  const pool=MONSTERS.slice(Math.max(0,idx-1), idx+1);
  const base=pool[R(0,pool.length-1)];
  return { ...base, hp:R(base.hp[0],base.hp[1]), atk:R(base.atk[0],base.atk[1]), coin:R(base.coin[0],base.coin[1]), xp:R(base.xp[0],base.xp[1]) };
}

/* ---------------- Gear power & bonuses ---------------- */
function getItem(key){ return store.shop.items.find(i => i.key===key); }
function gearBonuses(user){
  const w = user.equipped?.weapon ? getItem(user.equipped.weapon) : null;
  const a = user.equipped?.armor  ? getItem(user.equipped.armor)  : null;
  const t = user.equipped?.trinket? getItem(user.equipped.trinket): null;
  const weaponPow = (w?.type==='weapon')?(w.power||0):0;
  const armorPow  = (a?.type==='armor')?(a.power||0):0;
  const critChance = (w?.critChance||0) + (t?.critChance||0);
  const critDamage = 1 + (w?.critDamage||0);
  const block      = (a?.block||0);
  const xpMult     = 1 + (t?.xpMult||0);
  const coinMult   = 1 + (t?.coinMult||0);
  return { weaponPow, armorPow, critChance, critDamage, block, xpMult, coinMult, totalPow: weaponPow+armorPow };
}
function basePower(level){ return 1 + Math.floor(level/4); }
function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi, Number.isFinite(n)?n:0)); }

/* ---------------- Daily quests ---------------- */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function ensureDaily(user){
  if (user.daily && user.daily.date === todayISO()) return user.daily;
  // generate 3 tasks from a lightweight pool tuned for phones
  const tasks = [];
  const pick = (arr)=>arr[R(0,arr.length-1)];
  const t1 = { type:'pushups', desc:'Do pushups', unit:'reps', target: pick([20,40,60,100]), progress:0, rewardXp: pick([50,70]), rewardCoins: pick([30,50]) };
  const t2 = { type:'plank',   desc:'Hold plank (sec)', unit:'seconds', target: pick([60,120,180]), progress:0, rewardXp: pick([60,80]), rewardCoins: pick([35,55]) };
  const t3 = { type:'run_miles',desc:'Run (miles)', unit:'miles', target: pick([1,2,3]), progress:0, rewardXp: pick([80,120]), rewardCoins: pick([50,80]) };
  tasks.push(t1,t2,t3);
  user.daily = { date: todayISO(), tasks, claimed: false };
  return user.daily;
}
function applyDailyProgress(user, exercise, amount, unit){
  const d = ensureDaily(user);
  for (const t of d.tasks) {
    if (t.type === exercise && (t.unit === unit || !unit)) {
      t.progress = Math.min(t.target, (t.progress||0) + amount);
    }
  }
  // special: generic contributions
  if (exercise==='pushups' && unit==='reps'){
    const plankTask = d.tasks.find(x=>x.type==='plank');
    if (plankTask && plankTask.progress < plankTask.target && amount>=50) plankTask.progress += 10; // tiny synergy bonus
  }
}
function dailyEmbed(user){
  const d=ensureDaily(user);
  const lines = d.tasks.map((t,i)=>{
    const pct = Math.min(100, Math.floor((t.progress/t.target)*100));
    return `${i+1}. **${t.desc}** — ${t.progress}/${t.target} ${t.unit} 〔${pct}%〕  → Reward: +${t.rewardXp} XP, +${t.rewardCoins} coins`;
  });
  return new EmbedBuilder().setTitle(`📅 Daily Quests — ${d.date}`).setColor(0x00C2FF)
    .setDescription(lines.join('\n') + `\n\nUse **/daily claim** when all three are complete for a chest bonus.`);
}

/* ---------------- Events (simple scheduler) ---------------- */
function fmtTime(ts){ const d=new Date(ts); return d.toLocaleString('en-US'); }

/* ---------------- Slash commands ---------------- */
const commands = [
  // Help
  new SlashCommandBuilder().setName('help').setDescription('Show all commands & tips'),

  // Mobile quick logging
  new SlashCommandBuilder().setName('quicklog').setDescription('Tap-to-log workout (mobile-friendly buttons)'),

  // One-arg shortcuts
  new SlashCommandBuilder().setName('p').setDescription('Log pushups quickly').addNumberOption(o=>o.setName('amount').setDescription('reps').setRequired(true)),
  new SlashCommandBuilder().setName('plank').setDescription('Log plank quickly').addNumberOption(o=>o.setName('seconds').setDescription('seconds').setRequired(true)),
  new SlashCommandBuilder().setName('runmiles').setDescription('Log running (miles)').addNumberOption(o=>o.setName('miles').setDescription('miles').setRequired(true)),
  new SlashCommandBuilder().setName('bench').setDescription('Log bench (weighted reps)')
    .addNumberOption(o=>o.setName('reps').setDescription('reps').setRequired(true))
    .addNumberOption(o=>o.setName('weight').setDescription('weight').setRequired(true))
    .addStringOption(o=>o.setName('weight_unit').setDescription('lb or kg').addChoices({name:'lb',value:'lb'},{name:'kg',value:'kg'}).setRequired(true)),

  // General logger
  new SlashCommandBuilder().setName('log').setDescription('Log any workout for XP/coins')
    .addStringOption(o=>o.setName('exercise').setDescription('e.g., pushups, run_miles, bench').setRequired(true))
    .addNumberOption(o=>o.setName('amount').setDescription('Reps / seconds / minutes / miles / etc.').setRequired(true))
    .addStringOption(o=>o.setName('unit').setDescription('Unit (reps, seconds, minutes, miles, km, meters, laps, sessions, weighted_reps)')
      .addChoices(
        {name:'reps',value:'reps'},{name:'seconds',value:'seconds'},{name:'minutes',value:'minutes'},{name:'miles',value:'miles'},
        {name:'km',value:'km'},{name:'meters',value:'meters'},{name:'laps',value:'laps'},{name:'sessions',value:'sessions'},
        {name:'weighted_reps (barbell lifts)',value:'weighted_reps'}
      ))
    .addNumberOption(o=>o.setName('weight').setDescription('for weighted lifts').setRequired(false))
    .addStringOption(o=>o.setName('weight_unit').setDescription('lb or kg').addChoices({name:'lb',value:'lb'},{name:'kg',value:'kg'}).setRequired(false)),

  // Info & economy
  new SlashCommandBuilder().setName('stats').setDescription('Your level, coins, and power'),
  new SlashCommandBuilder().setName('gear').setDescription('Your gear & bonuses'),
  new SlashCommandBuilder().setName('coins').setDescription('Your coin balance'),
  new SlashCommandBuilder().setName('shop').setDescription('Browse items to buy'),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item').addStringOption(o=>o.setName('item_key').setDescription('key from /shop').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('Your items'),
  new SlashCommandBuilder().setName('equip').setDescription('Equip a weapon/armor/trinket/cosmetic by key').addStringOption(o=>o.setName('item_key').setDescription('from inventory').setRequired(true)),

  // Encounters & raids
  new SlashCommandBuilder().setName('adventure').setDescription('Quick fight vs a random monster'),

  new SlashCommandBuilder().setName('raidstart').setDescription('Admin: start a raid boss (tier 1-5)')
    .addIntegerOption(o=>o.setName('tier').setDescription('1 (easy) to 5 (hard)').setRequired(true))
    .addIntegerOption(o=>o.setName('duration_min').setDescription('duration in minutes').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('raidstatus').setDescription('Show the current raid status'),
  new SlashCommandBuilder().setName('raidend').setDescription('Admin: end the current raid now').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Dailies & streaks
  new SlashCommandBuilder().setName('daily').setDescription('Your daily quests (claim when complete)')
    .addSubcommand(s=>s.setName('show').setDescription('Show today’s quests'))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim rewards if all tasks are complete')),
  new SlashCommandBuilder().setName('streak').setDescription('See your daily logging streak'),

  // Events (simple)
  new SlashCommandBuilder().setName('eventcreate').setDescription('Create a simple reminder event')
    .addStringOption(o=>o.setName('title').setDescription('What is it?').setRequired(true))
    .addIntegerOption(o=>o.setName('minutes_from_now').setDescription('Start in how many minutes?').setRequired(true))
    .addStringOption(o=>o.setName('reminders').setDescription('CSV minutes before (e.g., 30,10,5)').setRequired(false)),
  new SlashCommandBuilder().setName('eventlist').setDescription('List upcoming events'),
  new SlashCommandBuilder().setName('eventcancel').setDescription('Cancel an event by id').addStringOption(o=>o.setName('id').setDescription('event id from /eventlist').setRequired(true)),

  // Config & ping
  new SlashCommandBuilder().setName('setlevelupchannel').setDescription('Admin: set channel for level-up announcements')
    .addChannelOption(o=>o.setName('channel').setDescription('channel').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('ping').setDescription('Check if bot can reply')
].map(c=>c.toJSON());

/* ---------------- Register & ready ---------------- */
const rest = new REST({ version:'10' }).setToken(token);
async function registerCommands(){ await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands }); console.log('✅ Commands registered'); }
client.once('ready', () => { console.log(`🤖 Logged in as ${client.user.tag}`); registerCommands().catch(console.error); startEventTicker(); });

/* ---------------- Components: QuickLog & Raids ---------------- */
const quickState = new Map(); // messageId -> { userId, exercise, amount, unit }
function panelText(s){
  const ex = s.exercise ? `**${s.exercise}**` : 'none';
  const amt = s.amount||0;
  const unit = s.unit || (s.exercise ? (BUILT_INS[s.exercise]?.unit || '') : '');
  return `**Quick Log**\nPick a workout, tap amounts, then Submit.\nCurrent: ${ex} (${amt} ${unit})`;
}
function raidEmbed(r){
  const pct = Math.max(0, Math.min(1, r.hp / r.maxHp));
  const barLen = 20, filled = Math.round(pct * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
  const minsLeft = Math.max(0, Math.ceil((r.endsAt - Date.now()) / 60000));
  const top = Object.entries(r.contributions||{}).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([id,d],i)=>`${i+1}. <@${id}> — ${d}`);
  return new EmbedBuilder().setTitle(`🧟 Raid: ${r.bossName} (Tier ${r.tier})`).setColor(0xFF6B6B)
    .setDescription(`HP: **${r.hp}/${r.maxHp}**\n${bar}\n⏳ Ends in ~${minsLeft} min`)
    .addFields({ name:'Top damage', value: top.length? top.join('\n') : 'No hits yet.' });
}
function raidButtons(){
  return [ new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('raid:join').setLabel('Join').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('raid:hit').setLabel('Attack').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('raid:status').setLabel('Status').setStyle(ButtonStyle.Secondary)
  ) ];
}

/* ---------------- Help embed ---------------- */
function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('📘 FitRPG — Commands')
    .setColor(0x00c2ff)
    .setDescription(`Phone-first logging, RPG battles, raids, shop, dailies & events.\nTimezone note: ${store.config.timezoneNote}`)
    .addFields(
      { name: 'Quick Logging (mobile)', value:
        '`/quicklog` → dropdown + +1/+5/+10/+30/+60 → Submit\n' +
        '`/p amount:<reps>`  (pushups)\n' +
        '`/plank seconds:<sec>`\n' +
        '`/runmiles miles:<mi>`\n' +
        '`/bench reps:<r> weight:<w> weight_unit:<lb|kg>`'
      },
      { name: 'General Logger', value:
        '`/log exercise:<name> amount:<n> unit:<unit> [weight] [weight_unit]`\n' +
        'Built-ins: pushups, situps, squats, plank, pullups, run_miles, bench, deadlift, squat_barbell, ohp, legpress …'
      },
      { name: 'RPG & Progress', value:
        '`/stats`, `/gear`, `/coins`, `/shop`, `/buy`, `/inventory`, `/equip`\n' +
        '`/adventure` (quick fight)\n' +
        '`/raidstart`, `/raidstatus`, `/raidend`'
      },
      { name: 'Daily & Streak', value:
        '`/daily show`  |  `/daily claim` (after all 3 tasks complete)\n' +
        '`/streak` (bonus at milestones)'
      },
      { name: 'Events (simple reminders)', value:
        '`/eventcreate title:<text> minutes_from_now:<min> [reminders:30,10,5]`\n' +
        '`/eventlist`  |  `/eventcancel id:<id>`'
      },
      { name: 'Admin Setup', value:
        '`/setlevelupchannel channel:#level-ups`\n' +
        'Create roles: Novice/Apprentice/Warrior/Champion/Legend and place bot’s role above them.'
      }
    );
}

/* ---------------- Interaction handling ---------------- */
client.on('interactionCreate', async (interaction) => {
  // Component interactions (buttons/selects) for mobile quicklog & raids
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId.startsWith('ql:')) return handleQuickLogComponent(interaction);
      if (interaction.customId.startsWith('raid:')) return handleRaidComponent(interaction);
    } catch(e){ console.error(e); }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const uid = interaction.user.id;
  const me = ensureUser(uid);

  try {
    if (interaction.commandName === 'ping') return interaction.reply('Pong! ✅');

    if (interaction.commandName === 'help') {
      return interaction.reply({ embeds:[helpEmbed()], ephemeral:true });
    }

    if (interaction.commandName === 'setlevelupchannel') {
      const ch = interaction.options.getChannel('channel', true);
      store.config.levelUpChannelId = ch.id; save();
      return interaction.reply(`Level-up announcements will go to <#${ch.id}>.`);
    }

    /* ---------- QUICK MOBILE LOGGING ---------- */
    if (interaction.commandName === 'quicklog') {
      const row1 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('ql:select').setPlaceholder('Choose workout').addOptions(MOBILE_EXERCISE_CHOICES)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ql:+1').setLabel('+1').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ql:+5').setLabel('+5').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ql:+10').setLabel('+10').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ql:+30').setLabel('+30').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ql:+60').setLabel('+60').setStyle(ButtonStyle.Secondary)
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ql:submit').setLabel('Submit').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ql:reset').setLabel('Reset').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ql:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
      );
      await interaction.reply({ content:`**Quick Log**\nPick a workout, tap amounts, then Submit.\nCurrent: none (0)`, components:[row1,row2,row3], ephemeral:true });
      return;
    }

    /* ---------- SHORTCUTS ---------- */
    if (interaction.commandName === 'p')     return doLog(interaction, me, { exercise:'pushups', amount: interaction.options.getNumber('amount'), unit:'reps' });
    if (interaction.commandName === 'plank') return doLog(interaction, me, { exercise:'plank',   amount: interaction.options.getNumber('seconds'), unit:'seconds' });
    if (interaction.commandName === 'runmiles') return doLog(interaction, me, { exercise:'run_miles', amount: interaction.options.getNumber('miles'), unit:'miles' });
    if (interaction.commandName === 'bench') {
      return doLog(interaction, me, {
        exercise:'bench',
        amount: interaction.options.getNumber('reps'),
        unit:'weighted_reps',
        weight: interaction.options.getNumber('weight'),
        weightUnit: interaction.options.getString('weight_unit')
      });
    }

    /* ---------- GENERIC /log ---------- */
    if (interaction.commandName === 'log') {
      const exercise = interaction.options.getString('exercise');
      const amount   = interaction.options.getNumber('amount');
      const unit     = interaction.options.getString('unit') || undefined;
      const weight   = interaction.options.getNumber('weight') || undefined;
      const weightUnit = interaction.options.getString('weight_unit') || undefined;
      if (!exercise || !amount || amount <= 0) return interaction.reply({ content:'Provide a valid exercise and positive amount.', ephemeral:true });
      return doLog(interaction, me, { exercise, amount, unit, weight, weightUnit });
    }

    /* ---------- Info & economy ---------- */
    if (interaction.commandName === 'coins') return interaction.reply(`🪙 **${interaction.user.username}** has **${me.coins}** coins.`);
    if (interaction.commandName === 'shop') {
      const lvl = levelFromXp(me.xp);
      const lines = store.shop.items.map(it =>
        `• **${it.name}** \`${it.key}\` — ${it.price} coins` +
        ((it.type==='weapon'||it.type==='armor')?` (power ${it.power})`:'') +
        (it.levelReq?` 〔req: L${it.levelReq}〕`:``) +
        (it.desc?` — ${it.desc}`:``) +
        (it.xpMult?` 〔+${Math.round(it.xpMult*100)}% XP〕`:``) +
        (it.coinMult?` 〔+${Math.round(it.coinMult*100)}% coins〕`:``) +
        (it.critChance?` 〔+${Math.round(it.critChance*100)}% crit〕`:``) +
        (it.block?` 〔+${Math.round(it.block*100)}% block〕`:``) +
        (it.roleReward?` 〔Grants role: ${it.roleReward}〕`:``)
      );
      return interaction.reply(lines.length? `🛒 **Shop** (you are L${lvl})\n${lines.join('\n')}` : 'Shop is empty.');
    }
    if (interaction.commandName === 'buy') {
      const key = norm(interaction.options.getString('item_key')); const it=getItem(key);
      if(!it) return interaction.reply({ content:'No such item. Use /shop to see keys.', ephemeral:true });
      const lvl = levelFromXp(me.xp);
      if (it.levelReq && lvl < it.levelReq) return interaction.reply({ content:`Requires level ${it.levelReq}. You are level ${lvl}.`, ephemeral:true });
      if (me.coins < it.price) return interaction.reply({ content:`Not enough coins. Need ${it.price}.`, ephemeral:true });
      me.coins -= it.price; me.inventory.push(it.key); save();
      if(it.roleReward){ try{ const guild=await client.guilds.fetch(guildId); const role=guild.roles.cache.find(r=>r.name===it.roleReward); if(role){ const member=await guild.members.fetch(uid); await member.roles.add(role.id,'Shop reward'); } }catch(e){ console.warn('Role reward', e.message); } }
      return interaction.reply(`Purchased **${it.name}** for **${it.price}** coins! Use /inventory and /equip.`);
    }
    if (interaction.commandName === 'inventory') {
      if(!me.inventory.length) return interaction.reply('🎒 Inventory empty. Buy something in /shop!');
      const lines = me.inventory.map(k => { const it=getItem(k); return it? `• ${it.name} \`${it.key}\`${(it.type==='weapon'||it.type==='armor')?` (power ${it.power})`:''}` : `• ${k}`; });
      return interaction.reply(`🎒 **Inventory**\n${lines.join('\n')}`);
    }
    if (interaction.commandName === 'equip') {
      const key = norm(interaction.options.getString('item_key'));
      if(!me.inventory.includes(key)) return interaction.reply({ content:'You don’t own that item.', ephemeral:true });
      const it = getItem(key); if(!it) return interaction.reply({ content:'Unknown item.', ephemeral:true });
      if (it.type==='weapon') me.equipped.weapon=it.key;
      else if (it.type==='armor') me.equipped.armor=it.key;
      else if (it.type==='trinket') me.equipped.trinket=it.key;
      else if (it.type==='cosmetic') me.equipped.cosmetic=it.key;
      else return interaction.reply({ content:'This item cannot be equipped.', ephemeral:true });
      save(); return interaction.reply(`Equipped **${it.name}**.`);
    }
    if (interaction.commandName === 'gear') {
      const lvl=levelFromXp(me.xp); const g=gearBonuses(me); const base=basePower(lvl); const total=base+g.totalPow;
      const embed = new EmbedBuilder().setTitle(`${interaction.user.username} — Gear & Bonuses`).setColor(0x8A2BE2)
        .addFields(
          { name:'Level', value:`**${lvl}** (${me.xp.toFixed(1)} XP)`, inline:true },
          { name:'Coins', value:`${me.coins}`, inline:true },
          { name:'Power', value:`**${total}** (Base ${base} + Gear ${g.totalPow})`, inline:true },
          { name:'Equipped', value:
            `Weapon: ${me.equipped.weapon? getItem(me.equipped.weapon)?.name : '—'}\n`+
            `Armor: ${me.equipped.armor? getItem(me.equipped.armor)?.name : '—'}\n`+
            `Trinket: ${me.equipped.trinket? getItem(me.equipped.trinket)?.name : '—'}\n`+
            `Cosmetic: ${me.equipped.cosmetic? getItem(me.equipped.cosmetic)?.name : '—'}` }
        );
      return interaction.reply({ embeds:[embed] });
    }
    if (interaction.commandName === 'stats') {
      const lvl=levelFromXp(me.xp); const g=gearBonuses(me); const base=basePower(lvl);
      const embed = new EmbedBuilder().setTitle(`${interaction.user.username} — Stats`).setColor(0x00c2ff)
        .addFields(
          { name:'Level', value:`**${lvl}** (${me.xp.toFixed(1)} XP)`, inline:true },
          { name:'Coins', value:`${me.coins}`, inline:true },
          { name:'Power', value:`**${base + g.totalPow}**`, inline:true }
        );
      return interaction.reply({ embeds:[embed] });
    }

    /* ---------- Adventure ---------- */
    if (interaction.commandName === 'adventure') {
      const now=Date.now(); if((now-(me.lastAdventure||0))/1000 < store.config.adventureCooldownSec)
        return interaction.reply({ content:`Adventure cooldown. Try again in ${Math.ceil(store.config.adventureCooldownSec - (now-me.lastAdventure)/1000)}s.`, ephemeral:true });

      const lvl = levelFromXp(me.xp); const g=gearBonuses(me); const base=basePower(lvl);
      const pAtk = base + g.weaponPow, pDef= base + g.armorPow, pHPmax=35+(lvl*3)+(g.armorPow*4);
      const m = pickMonster(lvl);
      const tierBoost = 1 + (m.tier-1)*0.18 + (lvl*0.005);
      m.coin = Math.floor(m.coin * tierBoost); m.xp = Math.floor(m.xp * (0.85 + (m.tier-1)*0.07));
      let pHP=pHPmax, mHP=m.hp, rounds=0, log=[];
      while(pHP>0 && mHP>0 && rounds<14){
        rounds++;
        const crit=Math.random()<(g.critChance||0);
        let dmg=Math.max(1, Math.floor(pAtk + Math.random()*pAtk/2)); if(crit) dmg=Math.floor(dmg*(g.critDamage||1));
        mHP-=dmg; log.push(`You hit **${m.name}** for **${dmg}**${crit?' (CRIT!)':''} 〔${Math.max(0,mHP)} HP left〕`); if(mHP<=0) break;
        const blocked=Math.random()<(g.block||0);
        let mdmg=Math.max(1, Math.floor(m.atk + Math.random()*m.atk/2) - Math.floor(pDef/3)); if(blocked) mdmg=Math.max(0,Math.floor(mdmg*0.3));
        pHP-=mdmg; log.push(`${m.name} hits you for **${mdmg}**${blocked?' (BLOCK!)':''} 〔${Math.max(0,pHP)} HP left〕`);
      }
      me.lastAdventure=now;
      if(mHP<=0 && pHP>0){
        const pre=lvl;
        let xpGain = clamp(m.xp * levelXpMultiplier(pre) * (g.xpMult||1), 0, 6000);
        let coinGain = clamp(m.coin * levelCoinMultiplier(pre) * (g.coinMult||1), 0, 8000);
        me.xp += xpGain; me.coins += Math.floor(coinGain);
        save();
        const post=levelFromXp(me.xp); if(post>pre) await awardAndAnnounceLevelUp(interaction, uid, pre, post);
        const embed = new EmbedBuilder().setTitle(`⚔️ Adventure — Victory vs ${m.name}!`).setColor(0xFFD166)
          .setDescription(log.join('\n'))
          .addFields(
            { name:'Rewards', value:`✨ XP: **${Math.floor(xpGain)}**  |  🪙 Coins: **${Math.floor(coinGain)}**`, inline:false },
            { name:'Totals',  value:`${me.xp.toFixed(1)} XP  |  ${me.coins} coins`, inline:false }
          );
        return interaction.reply({ embeds:[embed] });
      } else {
        const loss = Math.min(40, Math.floor(me.coins*0.06)); me.coins=Math.max(0, me.coins-loss); save();
        const embed = new EmbedBuilder().setTitle(`💀 Adventure — Defeated by ${m.name}`).setColor(0xEF476F)
          .setDescription(log.join('\n')).addFields({ name:'Penalty', value: loss?`Lost ${loss} coins`:'No coins lost.', inline:false });
        return interaction.reply({ embeds:[embed] });
      }
    }

    /* ---------- Raids ---------- */
    if (interaction.commandName === 'raidstart') {
      const tier = interaction.options.getInteger('tier', true);
      const durationMin = interaction.options.getInteger('duration_min', true);
      if (store.raids.active) return interaction.reply({ content:'A raid is already active. Use /raidstatus.', ephemeral:true });
      if (tier<1 || tier>5) return interaction.reply({ content:'Tier must be 1–5.', ephemeral:true });
      const names=['Colossal Slime','Forest Boar King','Night Bandit Lord','Ancient Golem','Sky Wyvern'];
      const name = names[tier-1];
      const baseHp = [400, 1200, 3000, 7000, 15000][tier-1];
      const maxHp = baseHp;
      const endsAt = Date.now() + durationMin*60*1000;
      const panel = await interaction.reply({ embeds:[raidEmbed({bossName:name,tier,maxHp,hp:maxHp,endsAt,contributions:{}})], components: raidButtons(), fetchReply:true });
      store.raids.active = { id:`raid_${Date.now()}`, bossName:name, tier, maxHp, hp:maxHp, endsAt, messageId:panel.id, channelId:panel.channelId, contributions:{}, joined:[] };
      save(); return;
    }
    if (interaction.commandName === 'raidstatus') {
      const r = store.raids.active; if(!r) return interaction.reply('No active raid.');
      return interaction.reply({ embeds:[raidEmbed(r)], components: raidButtons() });
    }
    if (interaction.commandName === 'raidend') {
      const r = store.raids.active; if(!r) return interaction.reply({ content:'No active raid.', ephemeral:true });
      await finalizeRaid(r, interaction.channel, false);
      return interaction.reply('Raid ended and rewards distributed (scaled for remaining HP).');
    }

    /* ---------- Daily & Streak ---------- */
    if (interaction.commandName === 'daily') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'show') {
        ensureDaily(me); save();
        return interaction.reply({ embeds:[dailyEmbed(me)] });
      }
      if (sub === 'claim') {
        const d = ensureDaily(me);
        const allDone = d.tasks.every(t => (t.progress||0) >= t.target);
        if (!allDone) return interaction.reply({ content:'Complete all 3 tasks before claiming.', ephemeral:true });
        if (d.claimed) return interaction.reply({ content:'Already claimed for today 🎉', ephemeral:true });
        // sum rewards + chest bonus
        const xpGain = d.tasks.reduce((a,t)=>a+t.rewardXp,0) + 100;
        const coinGain = d.tasks.reduce((a,t)=>a+t.rewardCoins,0) + 100;
        const pre=levelFromXp(me.xp);
        me.xp += xpGain; me.coins += coinGain; d.claimed = true;
        // streak bonus at milestones
        const bonus = (me.streak>0 && me.streak%7===0) ? 150 : 0;
        if (bonus) me.coins += bonus;
        save();
        const post=levelFromXp(me.xp); if(post>pre) await awardAndAnnounceLevelUp(interaction, uid, pre, post);
        return interaction.reply(`✅ Claimed daily chest: +${xpGain} XP, +${coinGain} coins${bonus?` (+${bonus} weekly streak bonus)`:''}!`);
      }
    }
    if (interaction.commandName === 'streak') {
      return interaction.reply(`🔥 **${interaction.user.username}** streak: **${me.streak}** day(s). Keep it going!`);
    }

    /* ---------- Events ---------- */
    if (interaction.commandName === 'eventcreate') {
      const title = interaction.options.getString('title', true);
      const minsFromNow = interaction.options.getInteger('minutes_from_now', true);
      const remStr = interaction.options.getString('reminders') || '30,10,5';
      const reminds = remStr.split(',').map(s=>parseInt(s.trim(),10)).filter(x=>Number.isFinite(x)&&x>0);
      const at = Date.now() + minsFromNow*60*1000;
      const ev = { id:`ev_${Date.now()}`, title, at, channelId: interaction.channelId, remindMins: reminds, createdBy: uid };
      store.events.push(ev); save();
      return interaction.reply(`📅 Event created: **${title}** at ${fmtTime(at)} (reminders: ${reminds.join(', ')} min before). ID: \`${ev.id}\``);
    }
    if (interaction.commandName === 'eventlist') {
      const now=Date.now();
      const upcoming = store.events.filter(e=>e.at>now).sort((a,b)=>a.at-b.at).slice(0,10);
      if(!upcoming.length) return interaction.reply('No upcoming events.');
      const lines = upcoming.map(e=>`• \`${e.id}\` — **${e.title}** at ${fmtTime(e.at)} 〔remind: ${e.remindMins.join(',')}m〕`);
      return interaction.reply('📅 **Upcoming Events**\n' + lines.join('\n'));
    }
    if (interaction.commandName === 'eventcancel') {
      const id = interaction.options.getString('id', true);
      const idx = store.events.findIndex(e=>e.id===id);
      if (idx === -1) return interaction.reply({ content:'No event with that id.', ephemeral:true });
      const [ev] = store.events.splice(idx,1); save();
      return interaction.reply(`🗑️ Canceled event: **${ev.title}**`);
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) interaction.reply({ content:'Error processing command.', ephemeral:true }).catch(()=>{});
  }
});

/* ---------------- Component handlers ---------------- */
async function handleQuickLogComponent(inter){
  const id = inter.customId; const msgId = inter.message.id;
  let s = quickState.get(msgId) || { userId: inter.user.id, exercise:null, amount:0, unit:null };
  if (id === 'ql:select') {
    const choice = inter.values?.[0];
    s.exercise = choice; s.unit = (BUILT_INS[choice]?.unit) || 'reps';
    quickState.set(msgId, s);
    return inter.update({ content: panelText(s), components: inter.message.components });
  }
  if (id.startsWith('ql:+')) {
    const inc = Number(id.split('+')[1]); s.amount = (s.amount||0) + inc; quickState.set(msgId, s);
    return inter.update({ content: panelText(s), components: inter.message.components });
  }
  if (id === 'ql:reset') { s.amount = 0; quickState.set(msgId, s); return inter.update({ content: panelText(s), components: inter.message.components }); }
  if (id === 'ql:cancel') { quickState.delete(msgId); return inter.update({ content:'Quick Log canceled.', components: [] }); }
  if (id === 'ql:submit') {
    if (!s.exercise || !s.amount || s.amount<=0) return inter.reply({ content:'Pick a workout and add some amount.', ephemeral:true });
    const me = ensureUser(inter.user.id);
    await doLog(inter, me, { exercise:s.exercise, amount:s.amount, unit:s.unit }, { replyEphemeral:false, isComponent:true });
    quickState.delete(msgId); try { await inter.message.edit({ components: [] }); } catch {}
    return;
  }
}

async function handleRaidComponent(inter){
  const r = store.raids.active; if(!r) return inter.reply({ content:'No active raid.', ephemeral:true });
  if (Date.now() > r.endsAt) { await finalizeRaid(r, inter.channel, true); return inter.reply({ content:'Raid has ended. Rewards distributed.', ephemeral:true }); }
  const uid = inter.user.id;
  if (inter.customId === 'raid:join') { if (!r.joined.includes(uid)) r.joined.push(uid); save(); return inter.reply({ content:'You joined the raid!', ephemeral:true }); }
  if (inter.customId === 'raid:status') return inter.reply({ embeds:[raidEmbed(r)], ephemeral:true });
  if (inter.customId === 'raid:hit') {
    const me = ensureUser(uid);
    const now=Date.now(); if((now-(me.lastRaidHit||0))/1000 < store.config.raidHitCooldownSec)
      return inter.reply({ content:`Cooldown: wait ${Math.ceil(store.config.raidHitCooldownSec - (now-me.lastRaidHit)/1000)}s.`, ephemeral:true });
    const lvl=levelFromXp(me.xp); const g=gearBonuses(me); const base=basePower(lvl);
    const tier=r.tier;
    const baseDmg = base + g.weaponPow + Math.floor(lvl/3) + tier*2;
    let dmg = Math.max(1, Math.floor(baseDmg + Math.random()*baseDmg/2));
    if (Math.random() < (g.critChance||0)) dmg = Math.floor(dmg * (g.critDamage||1));
    me.lastRaidHit=now; save();
    r.hp = Math.max(0, r.hp - dmg); r.contributions[uid] = (r.contributions[uid]||0) + dmg; save();
    try { const ch=await client.channels.fetch(r.channelId); const msg=await ch.messages.fetch(r.messageId); await msg.edit({ embeds:[raidEmbed(r)], components: raidButtons() }); } catch {}
    if(r.hp<=0){ await finalizeRaid(r, inter.channel, true); return inter.reply({ content:`You dealt **${dmg}** and landed the finishing blow! 🎉`, ephemeral:true }); }
    else return inter.reply({ content:`You hit for **${dmg}**! Boss HP now **${r.hp}/${r.maxHp}**.`, ephemeral:true });
  }
}

async function finalizeRaid(r, channel, defeated){
  const totalDmg = Object.values(r.contributions||{}).reduce((a,b)=>a+b,0);
  const participation = Object.keys(r.contributions||{}).length;
  const tierPoolXP   = [800, 2000, 4500, 9000, 16000][r.tier-1];
  const tierPoolCoin = [600, 1500, 3500, 7000, 12000][r.tier-1];
  const hpFactor = defeated ? 1.0 : Math.max(0.25, 1 - (r.hp / r.maxHp));
  const poolXP   = Math.floor(tierPoolXP * hpFactor * (1 + participation*0.03));
  const poolCoin = Math.floor(tierPoolCoin * hpFactor * (1 + participation*0.03));

  if (totalDmg <= 0) {
    await channel.send('Raid ended, but no one dealt damage. No rewards.');
  } else {
    let lines=[];
    for (const [id, dmg] of Object.entries(r.contributions)) {
      const share = dmg/totalDmg;
      const user = ensureUser(id);
      const pre = levelFromXp(user.xp);
      const xpGain = Math.max(10, Math.floor(poolXP * share));
      const coinGain = Math.max(6, Math.floor(poolCoin * share));
      user.xp += xpGain; user.coins += coinGain; save();
      const post=levelFromXp(user.xp);
      if (post>pre) {
        try {
          const chId = store.config.levelUpChannelId;
          const embed = new EmbedBuilder().setTitle('🎉 Level Up!').setColor(0x37d67a)
            .setDescription(`<@${id}> reached **Level ${post}**!`).addFields({ name:'Raid Reward', value:'Level-up from raid!' });
          if (chId) (await client.channels.fetch(chId)).send({ embeds:[embed] });
          else channel.send({ embeds:[embed] });
        } catch {}
      }
      lines.push(`• <@${id}> — +${xpGain} XP, +${coinGain} coins 〔${Math.floor(share*100)}%〕`);
    }
    await channel.send(`🏁 Raid finished ${defeated? '— Boss defeated!':'(time up)'}\n**Rewards:**\n${lines.join('\n')}`);
  }
  store.raids.active = null; save();
}

/* ---------------- Logging core (updates streak & dailies) ---------------- */
async function doLog(interaction, me, { exercise, amount, unit, weight, weightUnit }, opts={}){
  const now=Date.now();
  if ((now-(me.lastLog||0))/1000 < store.config.logCooldownSec)
    return interaction.reply({ content:`Cooldown: try again in ${Math.ceil(store.config.logCooldownSec - (now-me.lastLog)/1000)}s.`, ephemeral:true });

  const exKey = norm(exercise);
  const { xp, basis } = computeXP({ exercise:exKey, amount, unit, weight, weightUnit });
  const preLevel = levelFromXp(me.xp);
  const g=gearBonuses(me);

  let gain = clamp(xp * levelXpMultiplier(preLevel) * (g.xpMult||1), 0, 100000);
  me.xp += gain;
  const coinsEarned = Math.floor((gain/10) * levelCoinMultiplier(preLevel) * (g.coinMult||1));
  me.coins += coinsEarned;
  me.lastLog = now;

  // streak & dailies
  touchStreak(me);
  applyDailyProgress(me, exKey, amount, unit);
  save();

  const postLevel = levelFromXp(me.xp);
  if (postLevel > preLevel) await awardAndAnnounceLevelUp(interaction, interaction.user.id, preLevel, postLevel);

  const embed = new EmbedBuilder().setTitle('Workout Logged').setColor(0x00c2ff)
    .setDescription(`${interaction.user.username} logged **${amount} ${unit || (BUILT_INS[exKey]?.unit || '')} ${exKey}**`)
    .addFields(
      { name:'Basis', value:basis, inline:true },
      { name:'XP', value:`${gain.toFixed(1)}`, inline:true },
      { name:'Coins', value:`${coinsEarned}`, inline:true },
      { name:'Totals', value:`${me.xp.toFixed(1)} XP | ${me.coins} coins | 🔥 Streak: ${me.streak}`, inline:false }
    );

  if (opts.isComponent) return interaction.followUp({ embeds:[embed], ephemeral:false });
  else return interaction.reply({ embeds:[embed] });
}

/* ---------------- Level-up announce ---------------- */
async function awardAndAnnounceLevelUp(interaction, userId, prev, now){
  try { const guild=await client.guilds.fetch(guildId); const member=await guild.members.fetch(userId); await grantLevelRoles(guild, member, prev, now); } catch {}
  const me = ensureUser(userId);
  const levels = now - prev;
  const coinBonus = levels * (30 + Math.floor(now*1.5));
  me.coins += coinBonus;
  // 20% chance cosmetic
  let loot=''; if(Math.random()<0.20){ const cos=store.shop.items.filter(i=>i.type==='cosmetic'); if(cos.length){ const L=cos[R(0,cos.length-1)]; me.inventory.push(L.key); loot = `\n🎁 Bonus loot: **${L.name}**`; } }
  save();
  const embed = new EmbedBuilder().setTitle('🎉 Level Up!').setColor(0x37d67a)
    .setDescription(`**${interaction.user.username}** reached **Level ${now}**!`)
    .addFields({ name:'Rewards', value:`+${coinBonus} coins${loot}`, inline:false });
  try {
    const chId = store.config.levelUpChannelId;
    if (chId) (await client.channels.fetch(chId)).send({ embeds:[embed] });
    else interaction.channel.send({ embeds:[embed] });
  } catch {}
}

/* ---------------- Event ticker (checks reminders & starts) ---------------- */
function startEventTicker(){
  setInterval(async () => {
    const now = Date.now();
    const toRemove = [];
    for (const ev of store.events) {
      // Reminders
      if (ev.remindMins && ev.remindMins.length) {
        const minsUntil = Math.ceil((ev.at - now) / 60000);
        if (minsUntil <= 0) {
          // Start message
          try { const ch=await client.channels.fetch(ev.channelId); await ch.send(`📣 **${ev.title}** is starting **now**!`); } catch {}
          toRemove.push(ev.id);
        } else {
          // send "X minutes left" reminder if exact match
          const idx = ev.remindMins.indexOf(minsUntil);
          if (idx !== -1) {
            try { const ch=await client.channels.fetch(ev.channelId); await ch.send(`⏰ **${ev.title}** starts in **${minsUntil} min**.`); } catch {}
            // prevent duplicate: remove this reminder entry
            ev.remindMins.splice(idx,1); save();
          }
        }
      } else if (now >= ev.at) {
        try { const ch=await client.channels.fetch(ev.channelId); await ch.send(`📣 **${ev.title}** is starting **now**!`); } catch {}
        toRemove.push(ev.id);
      }
    }
    if (toRemove.length) {
      store.events = store.events.filter(e=>!toRemove.includes(e.id)); save();
    }
  }, 30 * 1000); // check twice per minute
}

/* ---------------- Login ---------------- */
client.login(token);
