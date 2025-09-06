// FitRPG Bot — XP Levels + Coins + Shop + Inventory + Equip + Leaderboard
// Requires: discord.js ^14

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');

// --- keep Render happy on a Web Service by opening a small HTTP server ---
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('FitRPG bot is running.\n');
}).listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID; // Application (Client) ID
const guildId  = process.env.GUILD_ID;  // Server (Guild) ID

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ---------------- Storage ---------------- */
const DATA_FILE = 'data.json';
let store = {
  users: {},
  customExercises: {},
  shop: { items: [] },
  config: {
    levelRoles: [
      { level: 1,  roleName: 'Novice' },
      { level: 5,  roleName: 'Apprentice' },
      { level: 10, roleName: 'Warrior' },
      { level: 20, roleName: 'Champion' },
      { level: 40, roleName: 'Legend' }
    ],
    logCooldownSec: 15
  }
};

if (fs.existsSync(DATA_FILE)) {
  try { store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
}
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }

/* ---------------- Exercises & XP ---------------- */
const BUILT_INS = {
  pushups: { unit: 'reps', rate: 0.5 },
  situps: { unit: 'reps', rate: 0.5 },
  squats: { unit: 'reps', rate: 0.5 },
  lunges: { unit: 'reps', rate: 0.6 },
  burpees: { unit: 'reps', rate: 1.0 },
  pullups: { unit: 'reps', rate: 1.5 },
  dips: { unit: 'reps', rate: 1.5 },
  plank: { unit: 'seconds', rate: 0.2 },
  run_miles: { unit: 'miles', rate: 20 },
  run: { unit: 'minutes', rate: 0.17 },
  cycle_miles: { unit: 'miles', rate: 8 },
  row_minutes: { unit: 'minutes', rate: 0.25 },
  swim_laps: { unit: 'laps', rate: 15 },
  bench: { unit: 'weighted_reps', rateWeight: 0.02 },
  legpress: { unit: 'weighted_reps', rateWeight: 0.02 },
  deadlift: { unit: 'weighted_reps', rateWeight: 0.02 },
  squat_barbell: { unit: 'weighted_reps', rateWeight: 0.02 },
  ohp: { unit: 'weighted_reps', rateWeight: 0.02 },
  strengthsession: { unit: 'sessions', rate: 25 }
};

const UNIT_DEFAULTS = {
  reps: 0.5,
  seconds: 0.2,
  minutes: 0.2,
  miles: 12,
  km: 7.5,
  meters: 0.012,
  laps: 10,
  sessions: 25
};

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, '_'); }
function toLbs(weight, unit) {
  if (!weight || weight <= 0) return 0;
  if (!unit || unit === 'lb' || unit === 'lbs') return weight;
  if (unit === 'kg') return weight * 2.2046226218;
  return weight;
}
function computeXP({ exercise, amount, unit, weight, weightUnit }) {
  const key = norm(exercise);
  const cfg = BUILT_INS[key] || store.customExercises[key];
  if (cfg && cfg.unit === 'weighted_reps') {
    const reps = amount;
    const lbs = toLbs(weight || 0, weightUnit);
    const xp = (cfg.rateWeight || 0.02) * (lbs * reps);
    return { xp, basis: `weighted: ${reps} reps @ ${lbs.toFixed(1)} lb` };
  }
  const useUnit = unit || (cfg ? cfg.unit : null);
  const rate = (cfg && cfg.rate) ?? UNIT_DEFAULTS[useUnit || 'reps'];
  const xp = (amount || 0) * (rate || 0);
  return { xp, basis: `${amount} ${useUnit || (cfg ? cfg.unit : 'units')}` };
}

/* ---------------- Levels ---------------- */
function levelFromXp(xp) {
  xp = Number(xp || 0);
  let lvl = 0, rem = xp;
  while (true) {
    const need = Math.floor(100 * Math.pow(lvl + 1, 1.4));
    if (rem >= need) { rem -= need; lvl++; } else break;
  }
  return lvl;
}

async function grantLevelRoles(guild, member, prevLevel, newLevel) {
  for (const th of store.config.levelRoles) {
    if (prevLevel < th.level && newLevel >= th.level) {
      const role = guild.roles.cache.find(r => r.name === th.roleName);
      if (role) {
        try { await member.roles.add(role.id, 'Level-up reward'); }
        catch (e) { console.warn('Role add error:', e.message); }
      }
    }
  }
}

/* ---------------- Shop ---------------- */
if (!store.shop.items || store.shop.items.length === 0) {
  store.shop.items = [
    { key: 'wooden_sword',  name: 'Wooden Sword',  type: 'weapon',   price: 50,  power: 2,  desc: 'Starter blade.' },
    { key: 'iron_sword',    name: 'Iron Sword',    type: 'weapon',   price: 150, power: 5,  desc: 'Reliable steel.' },
    { key: 'war_hammer',    name: 'War Hammer',    type: 'weapon',   price: 400, power: 9,  desc: 'Bonk with style.' },
    { key: 'dragon_lance',  name: 'Dragon Lance',  type: 'weapon',   price: 900, power: 15, desc: 'Legend-tier.' },
    { key: 'color_royal',   name: 'Royal Color',   type: 'cosmetic', price: 120, desc: 'Royal flair.', roleReward: 'Royal' },
    { key: 'title_champion',name: 'Title: Champion', type: 'cosmetic', price: 300, desc: 'Show off your title.', roleReward: 'Title: Champion' }
  ];
  save();
}

/* ---------------- Commands ---------------- */
const commands = [
  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log a workout and earn XP/coins')
    .addStringOption(o => o.setName('exercise').setDescription('e.g. pushups, run_miles, bench').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Reps / seconds / minutes / miles / etc.').setRequired(true))
    .addStringOption(o => o.setName('unit').setDescription('Unit (reps, seconds, minutes, miles, km, meters, laps, sessions, weighted_reps)')
      .addChoices(
        { name: 'reps', value: 'reps' }, { name: 'seconds', value: 'seconds' },
        { name: 'minutes', value: 'minutes' }, { name: 'miles', value: 'miles' },
        { name: 'km', value: 'km' }, { name: 'meters', value: 'meters' },
        { name: 'laps', value: 'laps' }, { name: 'sessions', value: 'sessions' },
        { name: 'weighted_reps (for barbell lifts)', value: 'weighted_reps' }
      )
    ),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show your XP / Level / Coins'),

  new SlashCommandBuilder()
    .setName('exercises')
    .setDescription('See built-in exercise keys and unit defaults'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top 10 by XP'),

  new SlashCommandBuilder()
    .setName('coins')
    .setDescription('Show your coin balance'),

  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse items to buy'),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item')
    .addStringOption(o => o.setName('item_key').setDescription('Item key from /shop').setRequired(true)),

  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('See your items'),

  new SlashCommandBuilder()
    .setName('equip')
    .setDescription('Equip an item')
    .addStringOption(o => o.setName('item_key').setDescription('Item key from your inventory').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('✅ Commands registered');
}

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands().catch(console.error);
});

/* ---------------- Interaction Handler ---------------- */
function ensureUser(id) {
  if (!store.users[id]) store.users[id] = { xp: 0, coins: 0, inventory: [], equipped: { weapon: null, cosmetic: null }, lastLog: 0 };
  return store.users[id];
}
function clampXP(x) { return Math.max(0, Math.min(Number.isFinite(x) ? x : 0, 100000)); }

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    // /log
    if (interaction.commandName === 'log') {
      const exercise = interaction.options.getString('exercise');
      const amount = interaction.options.getNumber('amount');
      const unit = interaction.options.getString('unit') || undefined;

      if (!exercise || !amount || amount <= 0) {
        return interaction.reply({ content: 'Please provide a valid exercise and positive amount.', ephemeral: true });
      }

      const me = ensureUser(interaction.user.id);
      const now = Date.now();
      if ((now - me.lastLog) / 1000 < store.config.logCooldownSec) {
        return interaction.reply({ content: `Cooldown active. Try again in ${Math.ceil(store.config.logCooldownSec - (now - me.lastLog)/1000)}s.`, ephemeral: true });
      }

      const { xp, basis } = computeXP({ exercise, amount, unit });
      const gain = clampXP(xp);
      const prevLvl = levelFromXp(me.xp);
      me.xp += gain;
      me.coins += Math.floor(gain / 10);
      me.lastLog = now;
      save();
      const newLvl = levelFromXp(me.xp);

      // assign level roles if thresholds crossed
      if (newLvl > prevLvl) {
        try {
          const guild = await client.guilds.fetch(guildId);
          const member = await guild.members.fetch(interaction.user.id);
          await grantLevelRoles(guild, member, prevLvl, newLvl);
        } catch {}
      }

      return interaction.reply(`+${gain.toFixed(1)} XP (${basis}) — Level ${newLvl}, Coins: ${me.coins}`);
    }

    // /stats
    if (interaction.commandName === 'stats') {
      const me = ensureUser(interaction.user.id);
      return interaction.reply(`${interaction.user.username} — XP: ${me.xp.toFixed(1)}, Level: ${levelFromXp(me.xp)}, Coins: ${me.coins}`);
    }

    // /shop
    if (interaction.commandName === 'shop') {
      const lines = store.shop.items.map(it =>
        `• **${it.name}** \`${it.key}\` — ${it.price} coins${it.type === 'weapon' ? ` (power ${it.power})` : ''}${it.desc ? ` — ${it.desc}` : ''}`
      );
      return interaction.reply(lines.length ? `🛒 **Shop**\n${lines.join('\n')}` : 'Shop is empty.');
    }

    // /buy
    if (interaction.commandName === 'buy') {
      const key = norm(interaction.options.getString('item_key'));
      const me = ensureUser(interaction.user.id);
      const item = store.shop.items.find(i => i.key === key);
      if (!item) return interaction.reply({ content: 'No such item. Use /shop to see keys.', ephemeral: true });
      if (me.coins < item.price) return interaction.reply({ content: `Not enough coins. Need ${item.price}.`, ephemeral: true });

      me.coins -= item.price;
      me.inventory.push(item.key);
      save();

      // Optional: role reward if the role exists and bot can assign
      if (item.roleReward) {
        try {
          const guild = await client.guilds.fetch(guildId);
          const role = guild.roles.cache.find(r => r.name === item.roleReward);
          if (role) {
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.add(role.id, 'Shop purchase reward');
          }
        } catch (e) { console.warn('Role reward error:', e.message); }
      }

      return interaction.reply(`Purchased **${item.name}** for **${item.price}** coins! Check /inventory and /equip.`);
    }

    // /inventory
    if (interaction.commandName === 'inventory') {
      const me = ensureUser(interaction.user.id);
      if (!me.inventory.length) return interaction.reply('Inventory empty. Buy something in /shop!');
      const lines = me.inventory.map(k => {
        const it = store.shop.items.find(i => i.key === k);
        return it ? `• ${it.name} \`${it.key}\`${it.type === 'weapon' ? ` (power ${it.power})` : ''}` : `• ${k}`;
      });
      return interaction.reply(`🎒 **Inventory**\n${lines.join('\n')}`);
    }

    // /equip
    if (interaction.commandName === 'equip') {
      const key = norm(interaction.options.getString('item_key'));
      const me = ensureUser(interaction.user.id);
      if (!me.inventory.includes(key)) return interaction.reply({ content: 'You don’t own that item.', ephemeral: true });
      const it = store.shop.items.find(i => i.key === key);
      if (!it) return interaction.reply({ content: 'Unknown item.', ephemeral: true });

      if (it.type === 'weapon') {
        me.equipped = me.equipped || { weapon: null, cosmetic: null };
        me.equipped.weapon = it.name;
      } else if (it.type === 'cosmetic') {
        me.equipped = me.equipped || { weapon: null, cosmetic: null };
        me.equipped.cosmetic = it.name;
      } else {
        return interaction.reply({ content: 'This item cannot be equipped.', ephemeral: true });
      }
      save();
      return interaction.reply(`Equipped **${it.name}**.`);
    }

    // /leaderboard
    if (interaction.commandName === 'leaderboard') {
      const rows = Object.entries(store.users)
        .map(([id, u]) => ({ id, xp: Number(u.xp || 0) }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 10);
      if (rows.length === 0) return interaction.reply('No users yet.');
      const lines = rows.map((r, i) => `${i + 1}. <@${r.id}> — ${r.xp.toFixed(1)} XP`);
      return interaction.reply('🏆 **Top 10 by XP**\n' + lines.join('\n'));
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      interaction.reply({ content: 'Error processing command.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(token);
