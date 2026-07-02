const mysql = require('mysql2/promise');

let pool;

async function initDb() {
    pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: process.env.DB_NAME || 'discord_bot',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: process.env.DB_HOST && process.env.DB_HOST !== '127.0.0.1' ? { rejectUnauthorized: false } : undefined
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
        CREATE TABLE IF NOT EXISTS user_activity (
            user_id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255),
            last_online BIGINT,
            last_notified BIGINT
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

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS pending_updates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            missing_column VARCHAR(255) NOT NULL,
            status ENUM('pending', 'asked', 'answered') DEFAULT 'pending',
            timestamp BIGINT,
            INDEX idx_user_status (user_id, status)
        );
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS auto_updates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            column_name VARCHAR(255) NOT NULL,
            value TEXT,
            timestamp BIGINT
        );
    `);

    const [rows] = await pool.execute('SELECT count(*) as count FROM questions');
    if (rows[0].count === 0) {
        console.log('Seeding database with sample questions...');

        const questions = [
            ["What is your full name?", "text", 1, true, null],
            ["Which of the following best describes your status with JerseySTEM?", "single_choice", 2, true, JSON.stringify(["Prospective Program Instructor", "Current Program Instructor", "Returning/Former Instructor"])],
            ["If you are a PROSPECTIVE instructor, why are you interested in joining? (If not, type 'skip')", "text", 3, true, null],
            ["If you are a CURRENT instructor, thank you for teaching! What classes are you currently teaching? (If not, type 'skip')", "text", 4, true, null],
            ["If you are a RETURNING/FORMER instructor, good to see you back! What classes did you teach previously? (If not, type 'skip')", "text", 5, true, null]
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
