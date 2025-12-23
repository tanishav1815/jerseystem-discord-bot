require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, REST, Routes } = require('discord.js');
const { initDb } = require('./db');
const formEngine = require('./formEngine');

// Initialize DB
initDb();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel] // For DMs
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Optional if we fetch user

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);

    // Register generic /start command globally (might take time to propagate)
    const commands = [
        {
            name: 'start',
            description: 'Start the questionnaire',
        },
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    (async () => {
        try {
            console.log('Started refreshing application (/) commands.');
            // Using applicationCommands for global commands
            await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error(error);
        }
    })();
});

client.on(Events.InteractionCreate, async interaction => {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'start') {
            await formEngine.startForm(interaction.user, interaction);
        }
        return;
    }

    // 2. Buttons & Select Menus
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const user = interaction.user;
        let answer = null;

        if (interaction.isButton()) {
            // ID format: choice_index
            const parts = interaction.customId.split('_');
            if (interaction.customId.startsWith('choice_')) {
                answer = parts[1]; // The index
            }
        } else if (interaction.isStringSelectMenu()) {
            answer = interaction.values; // Array of indices (as strings)
        }

        if (answer) {
            // Defer update to acknowledge the button click immediately without sending a new message yet
            await interaction.deferUpdate();

            // Process
            const result = await formEngine.handleInput(user, answer, 'interaction');

            // Interaction components usually should be disabled after use. 
            // For this simple bot, we might just assume the user moves on.
            // Or we could edit the original message to disable components. 
            // Let's skip disabling for now to keep code simple, but proceed flow.

            if (typeof result === 'string') {
                // Error / Validation message
                await interaction.followUp({ content: result, ephemeral: true });
            } else if (result && result.next) {
                await formEngine.sendQuestion(user, interaction.channel, result.next);
            } else if (result && result.finished) {
                await interaction.channel.send(`Thank you ${user.username}, you have completed the form!`);
            }
        }
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    // Check if user is in a session
    const session = formEngine.getUserSession(message.author.id);
    if (!session || session.is_completed) return;

    // Check if current question expects text
    // We need to peek at the current question.
    const questions = formEngine.getSortedQuestions();
    const currentQ = questions.find(q => q.order_index === session.current_order_index);

    if (currentQ && currentQ.question_type === 'text') {
        const result = await formEngine.handleInput(message.author, message.content, 'text');

        if (typeof result === 'string') {
            await message.reply(result);
        } else if (result && result.next) {
            await formEngine.sendQuestion(message.author, message.channel, result.next);
        } else if (result && result.finished) {
            await message.channel.send(`Thank you ${message.author.username}, you have completed the form!`);
        }
    }
});

client.login(TOKEN);
