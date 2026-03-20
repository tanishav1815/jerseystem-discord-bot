const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getDb } = require('./db');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

class FormEngine {
    constructor() {
        this.onlineLocks = new Set();

        // --- Interactive field options for missing info questions ---
        // Keys are matched case-insensitively against AI_fields FIELD_LABEL values
        this.fieldOptions = {
            't-shirt_size(adult)': {
                type: 'buttons',
                label: 'T-Shirt Size',
                choices: ['XS', 'S', 'M', 'L', 'XL']
            },
            't-shirt size': {
                type: 'buttons',
                label: 'T-Shirt Size',
                choices: ['XS', 'S', 'M', 'L', 'XL']
            },
            'school email': {
                type: null, // freeform text input
                label: 'School Email'
            },
            'graduation year': {
                type: 'dropdown',
                label: 'Graduation Year',
                choices: ['2024', '2025', '2026', '2027', '2028', '2029']
            }
        };
    }

    /**
     * Returns a friendly pre-written message for a missing field question.
     * This avoids burning a Gemini API call for every single field transition.
     */
    _getFallbackMessage(fieldName, remaining) {
        const transitions = [
            `Next up — what's your **${fieldName}**? 📝`,
            `Almost there! Could you share your **${fieldName}**? ✨`,
            `Moving along! 🚀 What's your **${fieldName}**?`,
            `One more thing — your **${fieldName}**? 😊`,
            `Quick one — what about your **${fieldName}**? 🎯`,
            `And your **${fieldName}**? 💬`,
            `Let's keep going! What's your **${fieldName}**? 🙌`
        ];
        const idx = Math.floor(Math.random() * transitions.length);
        let msg = transitions[idx];
        if (remaining > 1) {
            msg += ` (${remaining} more after this)`;
        }
        return msg;
    }

    /**
     * Tries to get a Gemini AI message, but falls back to a pre-written one on error (e.g. rate limits).
     */
    async _getSmartMessage(prompt, fieldName, remaining) {
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            const aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            return aiResponse.text.trim();
        } catch(e) {
            console.log(`Gemini rate limited, using fallback message for: ${fieldName}`);
            return this._getFallbackMessage(fieldName, remaining);
        }
    }

    _parseChoices(choicesStr) {
        if (!choicesStr) return [];
        try {
            return JSON.parse(choicesStr);
        } catch (e) {
            // Attempt to recover if they put "[Javascript, Python]" literally
            let clean = choicesStr.replace(/^\[/, '').replace(/\]$/, '');
            return clean.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
    }

    async sendMainMenu(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('🌟 Welcome to the Community!')
            .setDescription('We are incredibly excited to have you here.\n\nTo ensure you get the absolute most out of your experience and are placed in the right programs, please select an option from the menu below!')
            .setColor(0x00B0F0)
            .setImage('https://images.unsplash.com/photo-1522071820081-009f0129c71c?q=80&w=2070&auto=format&fit=crop') // Large hero banner image of a team collaborating
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .addFields(
                { name: '📋 Step 1: Onboarding', value: 'Click **Start Questionnaire** to set up your profile and preferences.', inline: true },
                { name: '💡 Step 2: Learn More', value: 'Click **Ask a Question** to search our official Knowledge Base.', inline: true },
                { name: '🛠️ Step 3: Admin Tools', value: 'Use the buttons below to announce new events or sync data.', inline: false }
            )
            .setFooter({ text: 'Community Support Bot', iconURL: interaction.client.user.displayAvatarURL() });

        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('menu_start')
                    .setLabel('Start Questionnaire')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📋'),
                new ButtonBuilder()
                    .setCustomId('menu_ask')
                    .setLabel('Ask a Question')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('💡')
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('menu_announce')
                    .setLabel('Announce Event')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('📢'),
                new ButtonBuilder()
                    .setCustomId('menu_sync')
                    .setLabel('Sync Database')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔄')
            );

        await interaction.reply({ embeds: [embed], components: [row1, row2] });
    }

    async handleMainMenuClick(interaction) {
        if (interaction.customId === 'menu_start') {
            await this.startForm(interaction.user, interaction);
        } else if (interaction.customId === 'menu_ask') {
            const modal = new ModalBuilder()
                .setCustomId('ask_modal')
                .setTitle('Ask the Knowledge Base');

            const queryInput = new TextInputBuilder()
                .setCustomId('query_input')
                .setLabel('What is your question?')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('Type your question here...');

            const row = new ActionRowBuilder().addComponents(queryInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        } else if (interaction.customId === 'menu_announce') {
            const modal = new ModalBuilder()
                .setCustomId('announce_modal')
                .setTitle('Create New Event');

            const eventInput = new TextInputBuilder()
                .setCustomId('event_input')
                .setLabel('What is the name of the event?')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('e.g., Fall 2026 Instructor Meetup');

            const row = new ActionRowBuilder().addComponents(eventInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        } else if (interaction.customId === 'menu_sync') {
            await this.syncQuestions(interaction);
        }
    }

    async getContextData() {
        const docIdsEnv = process.env.GOOGLE_DOC_IDS || process.env.GOOGLE_DOC_ID;
        const sheetIdsEnv = process.env.GOOGLE_SHEET_IDS;
        let combinedDocText = '';

        // 1. Download the text from Google Docs
        if (docIdsEnv) {
            const docIds = docIdsEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
            for (const docId of docIds) {
                try {
                    const docUrl = `https://docs.google.com/document/export?format=txt&id=${docId}`;
                    const response = await axios.get(docUrl, {
                        maxRedirects: 5,
                        responseType: 'text'
                    });
                    combinedDocText += `--- Google Document ID: ${docId} ---\n${response.data}\n\n`;
                } catch (err) { }
            }
        }

        // 1.2 Download the text from Google Sheets
        if (sheetIdsEnv) {
            const sheetIds = sheetIdsEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
            for (const sheetEntry of sheetIds) {
                try {
                    let sheetId = sheetEntry;
                    let gid = '0';
                    if (sheetEntry.includes('|')) {
                        [sheetId, gid] = sheetEntry.split('|');
                    }
                    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
                    const response = await axios.get(sheetUrl, {
                        maxRedirects: 5,
                        responseType: 'text'
                    });
                    combinedDocText += `--- Google Sheet (CSV Format) ---\n${response.data}\n\n`;
                } catch (err) { }
            }
        }

        try {
            const [answers] = await getDb().execute(`
                SELECT a.user_id, q.question_text, a.response
                FROM answers a
                JOIN questions q ON a.question_id = q.id
                WHERE LOWER(q.question_text) LIKE '%name%'
            `);
            let dbContext = "--- User Name Mappings from Database ---\n";
            answers.forEach(a => {
                dbContext += `Discord ID: ${a.user_id} | Real Name: ${a.response}\n`;
            });
            combinedDocText += dbContext + "\n";
        } catch (e) { }

        return combinedDocText;
    }

    async handleUserOnline(user, force = false) {
        if (!process.env.GEMINI_API_KEY) return;

        // Prevent concurrent double triggers
        if (this.onlineLocks.has(user.id)) return;
        this.onlineLocks.add(user.id);

        const now = Date.now();
        // Cooldown between DMs: Wait 2 days (48 hours)
        const COOLDOWN = 48 * 60 * 60 * 1000;

        try {
            const [rows] = await getDb().execute('SELECT * FROM user_activity WHERE user_id = ?', [user.id]);
            const activity = rows[0];

            if (!force && activity && activity.last_notified && (now - activity.last_notified < COOLDOWN)) {
                await getDb().execute('UPDATE user_activity SET last_online = ? WHERE user_id = ?', [now, user.id]);
                this.onlineLocks.delete(user.id);
                return; // Stop if recently notified
            }

            if (!activity) {
                await getDb().execute('INSERT INTO user_activity (user_id, username, last_online, last_notified) VALUES (?, ?, ?, ?)', [user.id, user.username, now, now]);
            } else {
                await getDb().execute('UPDATE user_activity SET last_online = ?, last_notified = ? WHERE user_id = ?', [now, now, user.id]);
            }

            // --- STEP 1: Match Discord user to their Contact record via Members table ---
            let realName = null;
            let discordHandle = null;

            try {
                // First try to match via Discord.Members table using Discord username
                const [memberRows] = await getDb().execute(
                    'SELECT username FROM Members WHERE username = ? OR nickName = ?',
                    [user.username, user.username]
                );
                if (memberRows.length > 0) {
                    discordHandle = memberRows[0].username;
                }
            } catch(e) {
                console.log('Members lookup error:', e.message);
            }

            if (!discordHandle) {
                // Fallback: check the bot's own answers table for a name
                try {
                    const [nameRows] = await getDb().execute(`
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = ? AND LOWER(q.question_text) LIKE '%name%'
                        LIMIT 1
                    `, [user.id]);
                    if (nameRows.length > 0 && nameRows[0].response) {
                        realName = nameRows[0].response.trim();
                    }
                } catch(e) {}

                if (!realName) {
                    console.log(`Could not identify ${user.username} in Contact or Members table. Skipping.`);
                    this.onlineLocks.delete(user.id);
                    return;
                }
            }

            // Look up the Contact record
            let contactRow = null;
            try {
                if (discordHandle) {
                    const [contactRows] = await getDb().execute(
                        'SELECT * FROM Contact WHERE Discord_Handle__c = ? LIMIT 1',
                        [discordHandle]
                    );
                    if (contactRows.length > 0) {
                        contactRow = contactRows[0];
                        realName = contactRow.FirstName || contactRow.Name || discordHandle;
                    }
                }

                // Fallback: search by name if Discord handle didn't match
                if (!contactRow && realName) {
                    const [contactRows] = await getDb().execute(
                        'SELECT * FROM Contact WHERE FirstName LIKE ? OR Name LIKE ? LIMIT 1',
                        [`%${realName}%`, `%${realName}%`]
                    );
                    if (contactRows.length > 0) {
                        contactRow = contactRows[0];
                        realName = contactRow.FirstName || contactRow.Name || realName;
                    }
                }
            } catch(e) {
                console.log('Contact lookup error:', e.message);
            }

            if (!contactRow) {
                console.log(`No Contact record found for ${user.username} (${realName || 'unknown'}). Skipping.`);
                this.onlineLocks.delete(user.id);
                return;
            }

            // --- STEP 2: Read AI_fields to find which columns to check, then identify NULLs ---
            let missingFields = [];

            try {
                const [aiFields] = await getDb().execute(
                    "SELECT FIELD_NAME, FIELD_LABEL, LEVEL FROM AI_fields ORDER BY CASE LEVEL WHEN 'Required' THEN 1 WHEN 'optional' THEN 2 WHEN 'nice to have' THEN 3 ELSE 4 END"
                );

                for (const field of aiFields) {
                    const columnName = field.FIELD_NAME;
                    const value = contactRow[columnName];

                    // Check if the field is NULL or empty
                    if (value === null || value === undefined || String(value).trim() === '') {
                        missingFields.push({
                            column: columnName,
                            label: field.FIELD_LABEL,
                            level: field.LEVEL
                        });
                    }
                }

                console.log(`AI_fields scan for ${realName}: ${missingFields.length} missing out of ${aiFields.length} fields`);
            } catch(e) {
                console.log('AI_fields scan error:', e.message);
            }

            // --- STEP 3: Check if there are still pending questions from a previous scan ---
            const [existingPending] = await getDb().execute(
                "SELECT * FROM pending_updates WHERE user_id = ? AND status IN ('pending', 'asked')",
                [user.id]
            );

            if (existingPending.length > 0) {
                // Already have queued questions, just re-ask the first unanswered one
                const nextQ = existingPending[0];
                if (nextQ.status === 'pending') {
                    await getDb().execute("UPDATE pending_updates SET status = 'asked' WHERE id = ?", [nextQ.id]);
                }
                
                const prompt = `You are a friendly, casual Discord bot for JerseySTEM. Write a SHORT (under 40 words), natural-sounding DM asking the user "${realName}" for their "${nextQ.missing_column}". Be conversational, use an emoji, and do NOT start with "Hey". Just ask the question naturally like a friend texting.`;
                const introText = await this._getSmartMessage(prompt, nextQ.missing_column, existingPending.length);
                await this.sendMissingFieldQuestion(user, nextQ.missing_column, introText);
                console.log(`Re-asked ${user.username} about: ${nextQ.missing_column}`);
                this.onlineLocks.delete(user.id);
                return true;
            }

            if (missingFields.length === 0) {
                // User is completely up to date!
                console.log(`${user.username} (${realName}) has no missing fields.`);
                this.onlineLocks.delete(user.id);
                return false;
            }

            // --- STEP 4: Queue ALL missing fields into pending_updates ---
            const fieldLabels = missingFields.map(f => f.label);
            console.log(`Found ${missingFields.length} missing fields for ${realName}: ${fieldLabels.join(', ')}`);
            for (const field of missingFields) {
                await getDb().execute(
                    'INSERT INTO pending_updates (user_id, missing_column, status, timestamp) VALUES (?, ?, ?, ?)',
                    [user.id, field.label, 'pending', now]
                );
            }

            // --- STEP 5: Ask about the FIRST missing field with a friendly AI message ---
            const firstField = missingFields[0];
            const firstLabel = firstField.label;
            await getDb().execute(
                "UPDATE pending_updates SET status = 'asked' WHERE user_id = ? AND missing_column = ? AND status = 'pending' LIMIT 1",
                [user.id, firstLabel]
            );

            const firstPrompt = `You are a friendly, casual Discord bot for JerseySTEM. The user "${realName}" just came online and they have ${missingFields.length} missing pieces of information in their profile. The missing fields are: ${fieldLabels.join(', ')}. 
                
Write a SHORT (under 50 words), warm, natural-sounding DM that:
1. Greets them casually (do NOT start with "Hey [Name]!" — vary it)
2. Mentions they have a few gaps in their profile
3. Asks them specifically for their "${firstLabel}" first
4. Uses an emoji or two
Be conversational, like a coworker texting.`;

            const introText = await this._getSmartMessage(firstPrompt, firstLabel, missingFields.length);
            await this.sendMissingFieldQuestion(user, firstLabel, introText);
            console.log(`Sent proactive DM for Missing Info to ${user.username} — asking about: ${firstLabel}`);
            
            return true;

        } catch (e) {
            console.error('handleUserOnline Error:', e.message);
            return false;
        } finally {
            this.onlineLocks.delete(user.id);
        }
    }

    /**
     * Sends a missing field question as interactive Discord components (buttons/dropdown)
     * or as plain text if no predefined options exist for the field.
     * @param {User|TextChannel} target - The user or channel to send to
     * @param {string} fieldName - The column header name from the sheet
     * @param {string} introText - The AI-generated conversational intro text
     */
    async sendMissingFieldQuestion(target, fieldName, introText) {
        const fieldKey = fieldName.toLowerCase().trim();
        const fieldConfig = this.fieldOptions[fieldKey];

        if (!fieldConfig || !fieldConfig.type) {
            // No predefined options — just send as plain text for freeform input
            await target.send(introText);
            return;
        }

        if (fieldConfig.type === 'buttons' && fieldConfig.choices.length <= 5) {
            // Render as a row of shiny buttons
            const row = new ActionRowBuilder();
            fieldConfig.choices.forEach((choice, idx) => {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`missing_btn_${idx}_${choice}`)
                        .setLabel(choice)
                        .setStyle(ButtonStyle.Secondary)
                );
            });

            const embed = new EmbedBuilder()
                .setTitle(`📋 ${fieldConfig.label}`)
                .setDescription(introText)
                .setColor(0x5865F2);

            await target.send({ embeds: [embed], components: [row] });

        } else {
            // Render as a dropdown select menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('missing_select')
                .setPlaceholder(`Select your ${fieldConfig.label}...`)
                .addOptions(
                    fieldConfig.choices.map((choice, idx) => ({
                        label: choice,
                        value: choice,
                        description: idx === fieldConfig.choices.length - 1 ? 'Choose if none of the above apply' : undefined
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setTitle(`📋 ${fieldConfig.label}`)
                .setDescription(introText)
                .setColor(0x5865F2);

            await target.send({ embeds: [embed], components: [row] });
        }
    }

    async askQuestion(interactionOrMessage, query) {
        // Supports either GOOGLE_DOC_ID (single) or GOOGLE_DOC_IDS (comma-separated multiple)
        const docIdsEnv = process.env.GOOGLE_DOC_IDS || process.env.GOOGLE_DOC_ID;
        const sheetIdsEnv = process.env.GOOGLE_SHEET_IDS;

        if (!docIdsEnv && !sheetIdsEnv) {
            return interactionOrMessage.reply({ content: "Knowledge base Document or Sheet IDs not configured.", ephemeral: true });
        }
        if (!process.env.GEMINI_API_KEY) {
            return interactionOrMessage.reply({ content: "Gemini API Key not configured.", ephemeral: true });
        }

        const isInteraction = typeof interactionOrMessage.deferReply === 'function';

        if (isInteraction) {
            await interactionOrMessage.deferReply();
        } else {
            await interactionOrMessage.channel.sendTyping();
        }

        try {
            let combinedDocText = await this.getContextData();

            const docText = combinedDocText;

            // 1.5 Fetch Chat History
            let chatHistoryTranscript = '';
            if (interactionOrMessage.channel) {
                try {
                    // Fetch the last 15 messages in the channel for context
                    const messages = await interactionOrMessage.channel.messages.fetch({ limit: 15 });
                    // Messages are returned newest first. Reverse to get chronological order.
                    const sortedMessages = Array.from(messages.values()).reverse();

                    chatHistoryTranscript = sortedMessages.map(msg => {
                        return `${msg.author.username}: ${msg.content}`;
                    }).join('\n');
                } catch (historyError) {
                    console.log("Could not fetch history:", historyError.message);
                }
            }

            // 2. Build the prompt for Gemini
            const prompt = `
            You are an intelligent, conversational assistant for a Discord community. 
            Use the Knowledge Base below as a resource to guide your conversation, but DO NOT rigidly repeat it verbatim. Respond naturally as a human would.
            Do not say "I don't have enough information" if you can actively infer the context from the recent chat history.

            CRITICAL SHEET INSTRUCTION: When reading the "Event Participation" spreadsheet (GID 103041255):
            - If a person has a "Y" under an event/date, they attended. 
            - If the cell under an event/date is blank (empty) or "N" for a person, it means they DID NOT attend that event! Do not say "not enough information", explicitly answer that they did not attend/were not present.

            CRITICAL RESPONSE FORMAT: You MUST ALWAYS output your response as a valid JSON object. Do not output raw text or markdown blocks.
            The JSON MUST have this exact structure:
            {
              "message": "The natural, conversational text you want to reply back to the user",
              "update_sheet": true or false, // Set to true ONLY IF the user's VERY LAST MESSAGE is a direct answer to a question you just asked them (e.g. they reply '2' to your list of options), OR if they explicitly ask you to update a valid field in the Knowledge base.
              "update_column": "The exact name of the data field (e.g., 'What is your T-shirt size?') if update_sheet is true",
              "update_value": "The resolved value of their answer (e.g., if they typed 'L', resolve it to 'L') if update_sheet is true",
              "target_user": "The exact 'First Name' or target identity to update if explicitly specified by the user (e.g., 'Jake Bayers'). If they are referring to themselves or don't specify, leave this as null."
            }
            Do NOT set update_sheet to true if the user is just initiating a new topic or making a statement. Wait for them to answer your question first, UNLESS they use an explicit command like "update my size to L" or "update Jake's size to L"!

            --- RECENT CHAT HISTORY ---
            (Use this to understand the context of the user's question if they are referring to something said recently)
            ${chatHistoryTranscript}
            ---------------------------

            --- KNOWLEDGE BASE START ---
            ${docText}
            --- KNOWLEDGE BASE END ---

            User Question: ${query}
            `;

            // 3. Ask Gemini
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            const aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            let aiText = aiResponse.text.trim();
            aiText = aiText.replace(/```json/gi, '').replace(/```/g, '').trim();

            let messageToSend = aiText;
            let doUpdate = false;
            let updateCol = '';
            let updateVal = '';
            let targetUserMatch = null;

            try {
                const jsonObj = JSON.parse(aiText);
                messageToSend = jsonObj.message || aiText;
                if (jsonObj.update_sheet) {
                    doUpdate = true;
                    updateCol = jsonObj.update_column;
                    updateVal = jsonObj.update_value;
                    targetUserMatch = jsonObj.target_user || null;
                }
            } catch (e) {
                messageToSend = aiText;
            }

            // 4. Send the response back to Discord
            if (isInteraction) {
                await interactionOrMessage.followUp(messageToSend);
            } else {
                await interactionOrMessage.reply(messageToSend);
            }

            // 5. Fire off the background silent sync if the bot extracted conversational data!
            if (doUpdate && updateCol && updateVal) {
                try {
                    const payload = {
                        action: 'update_missing_info',
                        user_id: interactionOrMessage.author.id,
                        username: targetUserMatch ? targetUserMatch : interactionOrMessage.author.username, // Use extracted target or fallback to author
                        column: updateCol,
                        value: updateVal,
                        timestamp: new Date().toISOString()
                    };

                    // Send to Google Sheets over AppScript
                    await axios.post(process.env.WEBHOOK_URL, payload);

                    // Save to local MySQL instance
                    await getDb().execute('INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (?, ?, ?, ?)', [
                        interactionOrMessage.author.id,
                        updateCol,
                        updateVal,
                        Date.now()
                    ]);

                    await interactionOrMessage.channel.send(`*(✅ Automatically updated your **${updateCol}** profile sheet with: **${updateVal}**)*`);
                } catch (e) {
                    console.log("Failed to blind-sync AI response:", e.message);
                }
            }

        } catch (error) {
            console.error('Ask error:', error);
            if (isInteraction) {
                await interactionOrMessage.followUp('Sorry, I encountered an error trying to process your question.');
            } else {
                await interactionOrMessage.reply('Sorry, I encountered an error trying to process your question.');
            }
        }
    }
    async announceEvent(interaction, eventName) {
        const embed = new EmbedBuilder()
            .setTitle(eventName)
            .setDescription('Please let us know if you can make it!')
            .setColor(0x00AE86);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('event_accept')
                    .setLabel('Accept')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('event_decline')
                    .setLabel('Decline')
                    .setStyle(ButtonStyle.Danger)
            );

        // This posts the announcement in the channel where the command was run
        // You could also modify this to DM specific users!
        await interaction.reply({ content: '@everyone New Event!', embeds: [embed], components: [row] });
    }

    async handleEventResponse(interaction, eventName, response) {
        await interaction.deferReply({ ephemeral: true });

        try {
            await getDb().execute(
                'INSERT INTO event_responses (user_id, event_name, response, timestamp) VALUES (?, ?, ?, ?)',
                [interaction.user.id, eventName, response, Date.now()]
            );
            await interaction.followUp(`You have successfully **${response}ed** the event "${eventName}". Thank you for letting us know!`);
        } catch (error) {
            console.error('Failed to save event response:', error);
            await interaction.followUp('There was an error saving your response.');
        }
    }

    async getSortedQuestions() {
        const [rows] = await getDb().execute('SELECT * FROM questions ORDER BY order_index ASC');
        return rows;
    }

    async getUserSession(userId) {
        const [rows] = await getDb().execute('SELECT * FROM user_sessions WHERE user_id = ?', [userId]);
        return rows[0];
    }

    async syncQuestions(interaction) {
        if (!process.env.WEBHOOK_URL) {
            return interaction.reply({ content: "Webhook URL not configured.", ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        try {
            const response = await axios.get(process.env.WEBHOOK_URL);
            const data = response.data;

            if (!Array.isArray(data)) {
                return interaction.followUp('Invalid data received from Google Sheets. Is the doGet method configured?');
            }

            // Clear old questions
            await getDb().execute('DELETE FROM questions');

            // Insert new questions
            for (const q of data) {
                const choices = q.choices ? (typeof q.choices === 'string' ? q.choices : JSON.stringify(q.choices)) : null;
                const isRequired = String(q.is_required).toUpperCase() === 'TRUE' || q.is_required === true || q.is_required === 1;

                await getDb().execute(`
                    INSERT INTO questions (question_text, question_type, order_index, is_required, choices)
                    VALUES (?, ?, ?, ?, ?)
                `, [q.question_text || 'Untitled Question', q.question_type || 'text', parseInt(q.order_index) || 1, isRequired, choices]);
            }

            await interaction.followUp(`Successfully synced ${data.length} questions from Google Sheets!`);
        } catch (error) {
            console.error('Sync error:', error);
            await interaction.followUp('Failed to sync questions. Check bot logs.');
        }
    }

    async startForm(user, interaction) {
        // Reset or init session
        const questions = await this.getSortedQuestions();
        if (questions.length === 0) {
            return interaction.reply({ content: "No questions configured.", ephemeral: true });
        }

        const firstQ = questions[0];

        // Upsert session (MySQL syntax)
        await getDb().execute(`
            INSERT INTO user_sessions (user_id, current_order_index, is_completed, updated_at)
            VALUES (?, ?, 0, ?)
            ON DUPLICATE KEY UPDATE
            current_order_index = VALUES(current_order_index),
            is_completed = VALUES(is_completed),
            updated_at = VALUES(updated_at)
        `, [user.id, firstQ.order_index, Date.now()]);

        await this.sendQuestion(user, interaction, firstQ);
    }

    async sendQuestion(user, interactionOrChannel, question) {
        // Construct the UI
        const embed = new EmbedBuilder()
            .setTitle(`Question ${question.order_index}`)
            .setDescription(question.question_text)
            .setColor(0x00AE86);

        if (question.is_required) {
            embed.setFooter({ text: "Required" });
        } else {
            embed.setFooter({ text: "Optional (Type 'skip' to skip if text)" });
        }

        const components = [];

        if (question.question_type === 'single_choice' || question.question_type === 'yes_no') {
            let choices = [];
            if (question.question_type === 'yes_no') {
                choices = ['Yes', 'No']; // 0, 1
            } else {
                choices = this._parseChoices(question.choices);
            }

            // Use Select Menu if many choices, else Buttons
            if (choices.length > 5) {
                const menu = new StringSelectMenuBuilder()
                    .setCustomId('params_select')
                    .setPlaceholder('Select an option')
                    // Use index as value
                    .addOptions(choices.map((c, i) => ({ label: c.substring(0, 100), value: i.toString() })));

                const row = new ActionRowBuilder().addComponents(menu);
                components.push(row);
            } else {
                // Buttons
                const row = new ActionRowBuilder();
                choices.forEach((c, i) => {
                    row.addComponents(
                        new ButtonBuilder()
                            // Just use index
                            .setCustomId(`choice_${i}`)
                            .setLabel(c.substring(0, 80)) // Label limit
                            .setStyle(ButtonStyle.Primary)
                    );
                });
                components.push(row);
            }
        }
        else if (question.question_type === 'multiple_choice') {
            const choices = this._parseChoices(question.choices);
            const menu = new StringSelectMenuBuilder()
                .setCustomId('params_multi')
                .setPlaceholder('Select one or more options')
                .setMinValues(1)
                .setMaxValues(choices.length)
                .addOptions(choices.map((c, i) => ({ label: c.substring(0, 100), value: i.toString() })));

            const row = new ActionRowBuilder().addComponents(menu);
            components.push(row);
        }
        else if (question.question_type === 'text') {
            embed.addFields({ name: 'Instructions', value: 'Please type your answer in the chat.' });
        }

        const payload = { embeds: [embed], components: components, fetchReply: true };

        let message;
        if (interactionOrChannel.isRepliable && interactionOrChannel.isRepliable()) {
            if (interactionOrChannel.replied || interactionOrChannel.deferred) {
                message = await interactionOrChannel.followUp(payload);
            } else {
                message = await interactionOrChannel.reply(payload);
            }
        } else {
            message = await interactionOrChannel.send(payload);
        }
        return message;
    }

    async handleInput(user, input, type) { // input is basic string (text) or array of strings (indices)
        const session = await this.getUserSession(user.id);
        if (!session || session.is_completed) return false;

        const questions = await this.getSortedQuestions();
        const currentQ = questions.find(q => q.order_index === session.current_order_index);
        if (!currentQ) return false;

        let answerValue = null;

        // Validation & extraction
        if (currentQ.question_type === 'text') {
            if (type !== 'text') return "Please type your answer.";
            answerValue = input;
        } else {
            // Interaction based
            if (type === 'text') return "Please use the buttons or menu to answer.";

            // Resolve indices to text
            let choices = [];
            if (currentQ.question_type === 'yes_no') choices = ['Yes', 'No'];
            else choices = this._parseChoices(currentQ.choices);

            // input is expected to be a string (single index) or array of strings (indices)
            const indices = Array.isArray(input) ? input : [input];

            const selectedValues = indices.map(idx => choices[parseInt(idx)]);

            if (selectedValues.some(v => v === undefined)) return "Invalid selection.";

            if (currentQ.question_type === 'multiple_choice') {
                answerValue = JSON.stringify(selectedValues);
            } else {
                answerValue = selectedValues[0];
            }
        }

        // Save Answer
        await getDb().execute('INSERT INTO answers (user_id, question_id, response, timestamp) VALUES (?, ?, ?, ?)', [
            user.id, currentQ.id, answerValue, Date.now()
        ]);

        // Advance
        const currentIndex = questions.findIndex(q => q.order_index === session.current_order_index);
        const nextQ = questions[currentIndex + 1];

        if (nextQ) {
            await getDb().execute('UPDATE user_sessions SET current_order_index = ?, updated_at = ? WHERE user_id = ?', [
                nextQ.order_index, Date.now(), user.id
            ]);
            return { next: nextQ };
        } else {
            await getDb().execute('UPDATE user_sessions SET is_completed = TRUE, updated_at = ? WHERE user_id = ?', [
                Date.now(), user.id
            ]);

            // --- WEBHOOK INTEGRATION ---
            try {
                // Fetch all answers for this user
                // We need to join with questions to make it readable
                const [answers] = await getDb().execute(`
                    SELECT q.question_text, a.response
                    FROM answers a
                    JOIN questions q ON a.question_id = q.id
                    WHERE a.user_id = ?
                    ORDER BY q.order_index ASC
                `, [user.id]);

                // Convert to a simple JSON object: { "Question 1": "Answer 1", ... }
                const payload = {
                    user_id: user.id,
                    username: user.username,
                    timestamp: new Date().toISOString(),
                    answers: {}
                };

                answers.forEach(a => {
                    payload.answers[a.question_text] = a.response;
                });

                if (process.env.WEBHOOK_URL) {
                    console.log(`Sending data to Webhook for user: ${user.username}`);
                    await axios.post(process.env.WEBHOOK_URL, payload);
                    console.log('Successfully sent to Webhook');
                } else {
                    console.log('WEBHOOK_URL not set, skipping integration.');
                }
            } catch (err) {
                console.error("Failed to send to Webhook:", err.message);
                // Don't block the user from seeing completion message
            }

            return { finished: true };
        }
    }

    async auditAllUsers(client) {
        try {
            console.log("Starting full background audit of all known users...");
            const [rows] = await getDb().execute('SELECT user_id FROM user_activity');
            for (const row of rows) {
                try {
                    const user = await client.users.fetch(row.user_id);
                    if (user && !user.bot) {
                        await this.handleUserOnline(user, true); // force=true to ignore cooldowns
                    }
                } catch(e) { /* user left or not found */ }
            }
            console.log("Full background audit complete.");
        } catch (e) {
            console.error('auditAllUsers Error:', e.message);
        }
    }

    async handleTwoWaySync(message, missingColumn) {
        if (!process.env.WEBHOOK_URL) {
            console.error("WEBHOOK_URL is missing! Unable to sync to Google Sheets.");
            return;
        }

        try {
            const payload = {
                action: 'update_missing_info',
                user_id: message.author.id,
                username: message.author.username,
                column: missingColumn,
                value: message.content,
                timestamp: new Date().toISOString()
            };

            await axios.post(process.env.WEBHOOK_URL, payload);

            // Save to local MySQL instance
            await getDb().execute('INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (?, ?, ?, ?)', [
                message.author.id,
                missingColumn,
                message.content,
                Date.now()
            ]);

            // Phase 3: Update the Contact table directly
            await this._updateContactField(message.author, missingColumn, message.content);

            console.log(`Successfully pushed 2-Way Sync update for ${message.author.username}: [${missingColumn}] = ${message.content}`);

            // Mark the CURRENT question as answered (don't delete all!)
            await getDb().execute(
                "UPDATE pending_updates SET status = 'answered' WHERE user_id = ? AND missing_column = ? AND status = 'asked' LIMIT 1",
                [message.author.id, missingColumn]
            );

            await message.reply(`✅ Got it! Updated your **${missingColumn}** successfully.`);

            // --- CHECK FOR NEXT MISSING FIELD ---
            const [nextPending] = await getDb().execute(
                "SELECT * FROM pending_updates WHERE user_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
                [message.author.id]
            );

            if (nextPending.length > 0) {
                const nextField = nextPending[0];
                await getDb().execute("UPDATE pending_updates SET status = 'asked' WHERE id = ?", [nextField.id]);

                // Get user's real name for a natural message
                let realName = message.author.username;
                try {
                    const [nameRows] = await getDb().execute(`
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = ? AND LOWER(q.question_text) LIKE '%name%'
                        LIMIT 1
                    `, [message.author.id]);
                    if (nameRows.length > 0) realName = nameRows[0].response.trim();
                } catch(e) {}

                // Count remaining
                const [remaining] = await getDb().execute(
                    "SELECT COUNT(*) as cnt FROM pending_updates WHERE user_id = ? AND status = 'pending'",
                    [message.author.id]
                );
                const left = remaining[0].cnt;

                const chainPrompt = `You are a friendly, casual Discord bot for JerseySTEM. The user "${realName}" just answered a question. They have ${left + 1} more fields to fill in their profile. Now ask them for their "${nextField.missing_column}". Write a SHORT (under 30 words), natural follow-up. Do NOT repeat "Got it" or "Thanks". Just smoothly transition to the next question like a friend texting. Use an emoji.`;
                const introText = await this._getSmartMessage(chainPrompt, nextField.missing_column, left);
                await this.sendMissingFieldQuestion(message.channel, nextField.missing_column, introText);
                console.log(`Chained next question for ${message.author.username}: ${nextField.missing_column}`);
            } else {
                // All fields are done!
                await message.channel.send("🎉 That's everything! Your profile is all filled in now. Thanks for taking the time!");
                console.log(`All missing fields complete for ${message.author.username}`);
            }

        } catch (e) {
            console.error("Failed to two-way sync to Google Sheets:", e.message);
            await message.reply("Thanks! (Note: I had trouble reaching the main server to save this instantly, but I've noted it).");
        }
    }

    /**
     * Updates a user's field directly in the cloned Contact table.
     * @param {User} discordUser - The Discord API User object
     * @param {string} fieldLabel - The friendly label from AI_fields
     * @param {string} value - The new value to save
     */
    async _updateContactField(discordUser, fieldLabel, value) {
        try {
            // 1. Get the real column name mapped in AI_fields
            const [aiFields] = await getDb().execute('SELECT FIELD_NAME FROM AI_fields WHERE FIELD_LABEL = ? LIMIT 1', [fieldLabel]);
            if (aiFields.length === 0) return false;
            const columnName = aiFields[0].FIELD_NAME;

            // 2. Get Discord handle from Members table
            const [members] = await getDb().execute(
                'SELECT username FROM Members WHERE username = ? OR nickName = ? LIMIT 1',
                [discordUser.username, discordUser.username]
            );
            
            let discordHandle = discordUser.username;
            if (members.length > 0) discordHandle = members[0].username;

            // 3. Update Contact directly! (Ensuring safety against SQL injection by allowing only mapped column names)
            await getDb().execute(
                `UPDATE Contact SET ${columnName} = ? WHERE Discord_Handle__c = ? LIMIT 1`, 
                [value, discordHandle]
            );
            
            console.log(`Successfully wrote to Contact table: ${discordHandle}'s ${columnName} = ${value}`);
            return true;
        } catch(e) {
            console.error('Failed to write directly to Contact table:', e.message);
            return false;
        }
    }

    /**
     * Handles button/dropdown interactions from missing-field prompts.
     * @param {Interaction} interaction - The Discord interaction
     * @param {string} selectedValue - The value the user selected
     */
    async handleMissingFieldInteraction(interaction, selectedValue) {
        const userId = interaction.user.id;

        // IMMEDIATELY acknowledge the interaction so Discord doesn't time out
        await interaction.deferUpdate();

        // Find the currently 'asked' pending field for this user
        const [pendingRows] = await getDb().execute(
            "SELECT * FROM pending_updates WHERE user_id = ? AND status = 'asked' ORDER BY id ASC LIMIT 1",
            [userId]
        );

        if (pendingRows.length === 0) {
            await interaction.followUp({ content: "Hmm, I don't have a pending question for you right now.", ephemeral: true });
            return;
        }

        const missingColumn = pendingRows[0].missing_column;

        try {
            // 1. Push to Google Sheets
            if (process.env.WEBHOOK_URL) {
                const payload = {
                    action: 'update_missing_info',
                    user_id: userId,
                    username: interaction.user.username,
                    column: missingColumn,
                    value: selectedValue,
                    timestamp: new Date().toISOString()
                };
                await axios.post(process.env.WEBHOOK_URL, payload);
            }

            // 2. Save to local MySQL
            await getDb().execute('INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (?, ?, ?, ?)', [
                userId, missingColumn, selectedValue, Date.now()
            ]);

            // Phase 3: Update the Contact table directly
            await this._updateContactField(interaction.user, missingColumn, selectedValue);

            // 3. Mark as answered
            await getDb().execute(
                "UPDATE pending_updates SET status = 'answered' WHERE user_id = ? AND missing_column = ? AND status = 'asked' LIMIT 1",
                [userId, missingColumn]
            );

            console.log(`Interactive update for ${interaction.user.username}: [${missingColumn}] = ${selectedValue}`);

            // 4. Replace the original embed/buttons with a confirmation
            await interaction.editReply({
                content: `✅ Got it! Updated your **${missingColumn}** to **${selectedValue}**.`,
                embeds: [],
                components: []
            });

            // 5. Chain to the next missing field
            const [nextPending] = await getDb().execute(
                "SELECT * FROM pending_updates WHERE user_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
                [userId]
            );

            if (nextPending.length > 0) {
                const nextField = nextPending[0];
                await getDb().execute("UPDATE pending_updates SET status = 'asked' WHERE id = ?", [nextField.id]);

                let realName = interaction.user.username;
                try {
                    const [nameRows] = await getDb().execute(`
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = ? AND LOWER(q.question_text) LIKE '%name%'
                        LIMIT 1
                    `, [userId]);
                    if (nameRows.length > 0) realName = nameRows[0].response.trim();
                } catch(e) {}

                const [remaining] = await getDb().execute(
                    "SELECT COUNT(*) as cnt FROM pending_updates WHERE user_id = ? AND status = 'pending'",
                    [userId]
                );
                const left = remaining[0].cnt;

                const chainPrompt = `You are a friendly, casual Discord bot for JerseySTEM. The user "${realName}" just selected "${selectedValue}" for "${missingColumn}". They have ${left + 1} more fields left. Now ask them for their "${nextField.missing_column}". Write a SHORT (under 30 words), natural follow-up. Do NOT repeat "Got it" or "Thanks". Just smoothly transition to the next question like a friend texting. Use an emoji.`;
                const introText = await this._getSmartMessage(chainPrompt, nextField.missing_column, left);
                // Send to the same channel
                const channel = interaction.channel || await interaction.user.createDM();
                await this.sendMissingFieldQuestion(channel, nextField.missing_column, introText);
                console.log(`Chained next interactive question for ${interaction.user.username}: ${nextField.missing_column}`);
            } else {
                const channel = interaction.channel || await interaction.user.createDM();
                await channel.send("🎉 That's everything! Your profile is all filled in now. Thanks for taking the time!");
                console.log(`All missing fields complete for ${interaction.user.username}`);
            }

        } catch (e) {
            console.error("Failed interactive two-way sync:", e.message);
            try {
                await interaction.reply({ content: "Thanks! (Note: I had trouble saving this, but I've noted your answer).", ephemeral: true });
            } catch(err) {}
        }
    }
}

module.exports = new FormEngine();
