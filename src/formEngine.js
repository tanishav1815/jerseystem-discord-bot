const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { getDb } = require('./db');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

class FormEngine {
    constructor() {
    }

    async askQuestion(interaction, query) {
        if (!process.env.GOOGLE_DOC_ID) {
            return interaction.reply({ content: "Knowledge base Document ID not configured.", ephemeral: true });
        }
        if (!process.env.GEMINI_API_KEY) {
            return interaction.reply({ content: "Gemini API Key not configured.", ephemeral: true });
        }

        await interaction.deferReply();

        try {
            // 1. Download the text from Google Docs
            const docUrl = `https://docs.google.com/document/export?format=txt&id=${process.env.GOOGLE_DOC_ID}`;
            const response = await axios.get(docUrl, {
                // Ensure axios faithfully follows all Google redirects for the raw text file
                maxRedirects: 5,
                responseType: 'text'
            });
            const docText = response.data;

            // 2. Build the prompt for Gemini
            const prompt = `
            You are a helpful assistant for a Discord community. 
            You must answer the user's question using ONLY the information provided in the Knowledge Base below.
            If the answer is not in the Knowledge Base, say "I don't have enough information to answer that."
            Do not make up facts. Keep answers concise and helpful.

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

            // 4. Send the response back to Discord
            await interaction.followUp(aiResponse.text);

        } catch (error) {
            console.error('Ask error:', error);
            await interaction.followUp('Sorry, I encountered an error trying to process your question.');
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
                choices = JSON.parse(question.choices || '[]');
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
            const choices = JSON.parse(question.choices || '[]');
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
            else choices = JSON.parse(currentQ.choices || '[]');

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
}

module.exports = new FormEngine();
