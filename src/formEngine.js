const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('./db');

class FormEngine {
    constructor() {
    }

    getSortedQuestions() {
        return db.prepare('SELECT * FROM questions ORDER BY order_index ASC').all();
    }

    getUserSession(userId) {
        return db.prepare('SELECT * FROM user_sessions WHERE user_id = ?').get(userId);
    }

    async startForm(user, interaction) {
        // Reset or init session
        const questions = this.getSortedQuestions();
        if (questions.length === 0) {
            return interaction.reply({ content: "No questions configured.", ephemeral: true });
        }

        const firstQ = questions[0];

        // Upsert session
        db.prepare(`
            INSERT INTO user_sessions (user_id, current_order_index, is_completed, updated_at)
            VALUES (?, ?, 0, ?)
            ON CONFLICT(user_id) DO UPDATE SET
            current_order_index = ?, is_completed = 0, updated_at = ?
        `).run(user.id, firstQ.order_index, Date.now(), firstQ.order_index, Date.now());

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
        const session = this.getUserSession(user.id);
        if (!session || session.is_completed) return false;

        const questions = this.getSortedQuestions();
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
        db.prepare('INSERT INTO answers (user_id, question_id, response, timestamp) VALUES (?, ?, ?, ?)').run(
            user.id, currentQ.id, answerValue, Date.now()
        );

        // Advance
        const currentIndex = questions.findIndex(q => q.order_index === session.current_order_index);
        const nextQ = questions[currentIndex + 1];

        if (nextQ) {
            db.prepare('UPDATE user_sessions SET current_order_index = ?, updated_at = ? WHERE user_id = ?').run(
                nextQ.order_index, Date.now(), user.id
            );
            return { next: nextQ };
        } else {
            db.prepare('UPDATE user_sessions SET is_completed = 1, updated_at = ? WHERE user_id = ?').run(
                Date.now(), user.id
            );
            return { finished: true };
        }
    }
}

module.exports = new FormEngine();
