require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, REST, Routes } = require('discord.js');
const { initDb, getDb } = require('./db');
const formEngine = require('./formEngine');

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
        {
            name: 'sync',
            description: 'Sync questions from Google Sheets',
        },
        {
            name: 'ask',
            description: 'Ask a question using the knowledge base',
            options: [
                {
                    name: 'query',
                    type: 3, // STRING
                    description: 'The question you want to ask',
                    required: true
                }
            ]
        },
        {
            name: 'announce',
            description: 'Announce an event and collect Accept/Decline responses',
            options: [
                {
                    name: 'event',
                    type: 3, // STRING
                    description: 'The name or description of the event',
                    required: true
                }
            ]
        },
        {
            name: 'menu',
            description: 'Send the Main Navigation Menu',
        },
        {
            name: 'audit_missing',
            description: 'Manually force a scan of all known users for missing information and ping them',
        }
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

    // Background CRON sweep: automatically scan every 24 hours (86400000ms) for missing info
    setInterval(() => {
        console.log("Triggering 24-hr CRON sweep for missing information...");
        formEngine.auditAllUsers(client);
    }, 24 * 60 * 60 * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
    // Proactively check if this user needs to be pinged about missing forms/events
    if (interaction.user && !interaction.user.bot) {
        formEngine.handleUserOnline(interaction.user);
    }

    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'start') {
            await formEngine.startForm(interaction.user, interaction);
        } else if (interaction.commandName === 'sync') {
            await formEngine.syncQuestions(interaction);
        } else if (interaction.commandName === 'ask') {
            const query = interaction.options.getString('query');
            await formEngine.askQuestion(interaction, query);
        } else if (interaction.commandName === 'announce') {
            const eventName = interaction.options.getString('event');
            await formEngine.announceEvent(interaction, eventName);
        } else if (interaction.commandName === 'menu') {
            await formEngine.sendMainMenu(interaction);
        } else if (interaction.commandName === 'audit_missing') {
            await interaction.reply({ content: '🔍 Starting background audit of all users...', ephemeral: true });
            await formEngine.auditAllUsers(client);
            await interaction.followUp({ content: '✅ Finished dispatching background missing information requests!', ephemeral: true });
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'ask_modal') {
            const query = interaction.fields.getTextInputValue('query_input');
            await formEngine.askQuestion(interaction, query);
        } else if (interaction.customId === 'announce_modal') {
            const eventName = interaction.fields.getTextInputValue('event_input');
            await formEngine.announceEvent(interaction, eventName);
        }
        return;
    }

    // 2. Buttons & Select Menus
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        if (interaction.isButton() && interaction.customId.startsWith('event_')) {
            const response = interaction.customId === 'event_accept' ? 'Accept' : 'Decline';
            const eventName = interaction.message.embeds[0]?.title || 'Unknown Event';
            await formEngine.handleEventResponse(interaction, eventName, response);
            return;
        }

        // --- Missing field BUTTON click (e.g. T-Shirt size: XS, S, M, L, XL) ---
        if (interaction.isButton() && interaction.customId.startsWith('missing_btn_')) {
            const selectedValue = interaction.customId.split('_').slice(3).join('_'); // Extract value after missing_btn_idx_
            await formEngine.handleMissingFieldInteraction(interaction, selectedValue);
            return;
        }

        // --- Missing field DROPDOWN selection (e.g. availability time slots) ---
        if (interaction.isStringSelectMenu() && interaction.customId === 'missing_select') {
            const selectedValue = interaction.values[0];
            await formEngine.handleMissingFieldInteraction(interaction, selectedValue);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('menu_')) {
            await formEngine.handleMainMenuClick(interaction);
            return;
        }

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

    // Track user online activity and check for missing tasks
    const handledProactive = await formEngine.handleUserOnline(message.author);
    if (handledProactive) {
        return; // Don't process further if we just triggered a proactive missing-info question
    }

    // Check if user is in a session
    const session = await formEngine.getUserSession(message.author.id);

    // Auto-Welcome & Questionnaire Trigger fallback
    if (!session) {
        try {
            await message.author.send("🌟 **Welcome to the JerseySTEM Community!** 🌟\n\nWe are incredibly excited to have you here. To set up your profile, please take 30 seconds to answer our quick onboarding questionnaire below:");
            await formEngine.startForm(message.author, message.author);
        } catch (e) {
            console.error(`Could not send welcome message to ${message.author.tag}.`, e.message);
        }
        return; // Don't process further
    }

    if (session.is_completed) {
        // 1. Two-Way Sync Interception (Are they answering a Missing Info question?)
        const [pendingRows] = await getDb().execute("SELECT * FROM pending_updates WHERE user_id = ? AND status = 'asked' ORDER BY id ASC LIMIT 1", [message.author.id]);
        if (pendingRows.length > 0) {
            await formEngine.handleTwoWaySync(message, pendingRows[0].missing_column);
            return;
        }

        // 2. Standard Chatbot 
        // If they are not in a form session or waitlist, check if they are talking to the bot directly (pinging it, or in DMs)
        const isDM = !message.guild;
        if (isDM || message.mentions.has(client.user)) {
            // Strip out the bot's mention from the message
            const query = message.content.replace(`<@${client.user.id}>`, '').trim();
            if (query.length > 0) {
                await formEngine.askQuestion(message, query);
            }
        }
        return;
    }

    // Check if current question expects text
    // We need to peek at the current question.
    const questions = await formEngine.getSortedQuestions();
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

// Initialize DB and then login
(async () => {
    try {
        await initDb();
        console.log('Database connected correctly.');
        client.login(TOKEN);
    } catch (e) {
        console.error('Failed connecting or initializing DB:', e);
    }
})();
