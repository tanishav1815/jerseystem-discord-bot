const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('form_bot.sqlite');

function initDb() {
    // strict mode tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_text TEXT NOT NULL,
            question_type TEXT NOT NULL, -- 'text', 'single_choice', 'multiple_choice', 'yes_no'
            order_index INTEGER NOT NULL,
            is_required INTEGER DEFAULT 1,
            choices TEXT -- JSON array string
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
            user_id TEXT PRIMARY KEY,
            current_order_index INTEGER DEFAULT 0,
            is_completed INTEGER DEFAULT 0,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            question_id INTEGER NOT NULL,
            response TEXT, -- JSON string or raw text
            timestamp INTEGER
        );
    `);

    // Seed data if empty
    const count = db.prepare('SELECT count(*) as count FROM questions').get();
    if (count.count === 0) {
        console.log('Seeding database with sample questions...');
        const insert = db.prepare(`
            INSERT INTO questions (question_text, question_type, order_index, is_required, choices)
            VALUES (@text, @type, @order, @req, @choices)
        `);

        const questions = [
            { text: "What is your full name?", type: "text", order: 1, req: 1, choices: null },
            { text: "Which department are you in?", type: "single_choice", order: 2, req: 1, choices: JSON.stringify(["Engineering", "HR", "Sales", "Marketing"]) },
            { text: "Do you have remote work experience?", type: "yes_no", order: 3, req: 1, choices: null },
            { text: "Select your programming skills (Multiple)", type: "multiple_choice", order: 4, req: 0, choices: JSON.stringify(["JavaScript", "Python", "C++", "Rust", "Go"]) },
            { text: "Any additional comments?", type: "text", order: 5, req: 0, choices: null }
        ];

        questions.forEach(q => insert.run(q));
    }
}

module.exports = {
    db,
    initDb
};
