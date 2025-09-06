const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Simple JSON storage
const dataFile = 'data.json';
let userData = {};
if (fs.existsSync(dataFile)) {
  userData = JSON.parse(fs.readFileSync(dataFile));
}

function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(userData, null, 2));
}

// Workout multipliers for XP
const workoutXP = {
  pushups: 5,
  situps: 5,
  pullups: 10,
  plank: 2,     // per second
  run: 20,      // per mile
  bench: 8,     // per rep
  legpress: 6   // per rep
};

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log a workout and gain XP')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Workout type')
        .setRequired(true)
        .addChoices(
          { name: 'Pushups', value: 'pushups' },
          { name: 'Situps', value: 'situps' },
          { name: 'Pullups', value: 'pullups' },
          { name: 'Plank (seconds)', value: 'plank' },
          { name: 'Running (miles)', value: 'run' },
          { name: 'Bench Press (reps)', value: 'bench' },
          { name: 'Leg Press (reps)', value: 'legpress' }
        )
    )
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of reps, seconds, or miles')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Check your fitness stats')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error(error);
  }
}

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'log') {
    const type = interaction.options.getString('type');
    const amount = interaction.options.getInteger('amount');

    const xp = workoutXP[type] * amount;
    const coins = Math.floor(xp / 10);

    if (!userData[interaction.user.id]) {
      userData[interaction.user.id] = { xp: 0, coins: 0 };
    }

    userData[interaction.user.id].xp += xp;
    userData[interaction.user.id].coins += coins;
    saveData();

    await interaction.reply(`${interaction.user.username} logged **${amount} ${type}** 🏋️\nGained **${xp} XP** and **${coins} coins**!`);
  }

  if (commandName === 'stats') {
    const stats = userData[interaction.user.id] || { xp: 0, coins: 0 };
    await interaction.reply(`${interaction.user.username}’s Stats:\n✨ XP: ${stats.xp}\n💰 Coins: ${stats.coins}`);
  }
});

client.login(token);
