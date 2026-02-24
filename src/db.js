const mysql = require('mysql2/promise');

let pool;

async function initDb() {
    pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: process.env.DB_NAME || 'discord_bot',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS questions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            question_text TEXT NOT NULL,
            question_type VARCHAR(50) NOT NULL,
            order_index INT NOT NULL,
            is_required BOOLEAN DEFAULT TRUE,
            choices TEXT
        );
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            user_id VARCHAR(255) PRIMARY KEY,
            current_order_index INT DEFAULT 0,
            is_completed BOOLEAN DEFAULT FALSE,
            updated_at BIGINT
        );
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS answers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            question_id INT NOT NULL,
            response TEXT,
            timestamp BIGINT
        );
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS event_responses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            event_name TEXT,
            response VARCHAR(50),
            timestamp BIGINT
        );
    `);

    const [rows] = await pool.execute('SELECT count(*) as count FROM questions');
    if (rows[0].count === 0) {
        console.log('Seeding database with sample questions...');

        const questions = [
            ["What is your full name?", "text", 1, true, null],
            ["Which department are you in?", "single_choice", 2, true, JSON.stringify(["Engineering", "HR", "Sales", "Marketing"])],
            ["Do you have remote work experience?", "yes_no", 3, true, null],
            ["Select your programming skills (Multiple)", "multiple_choice", 4, false, JSON.stringify(["JavaScript", "Python", "C++", "Rust", "Go"])],
            ["Any additional comments?", "text", 5, false, null]
        ];

        for (const q of questions) {
            await pool.execute(`
                INSERT INTO questions (question_text, question_type, order_index, is_required, choices)
                VALUES (?, ?, ?, ?, ?)
            `, q);
        }
    }
}

function getDb() {
    return pool;
}

module.exports = {
    initDb,
    getDb
};
