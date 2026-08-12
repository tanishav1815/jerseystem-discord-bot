import os
import json
import ssl
import asyncio
import aiomysql

pool = None
init_lock = asyncio.Lock()

async def init_db():
    global pool
    async with init_lock:
        if pool is not None:
            return

        db_host = os.getenv('DB_HOST', '127.0.0.1')
        db_port = int(os.getenv('DB_PORT', 3306))
        db_user = os.getenv('DB_USER', 'root')
        db_password = os.getenv('DB_PASSWORD', 'root')
        db_name = os.getenv('DB_NAME', 'discord_bot')
        
        # Configure SSL if not connecting locally
        ssl_ctx = None
        if db_host and db_host != '127.0.0.1':
            ssl_ctx = ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

        pool = await aiomysql.create_pool(
            host=db_host,
            port=db_port,
            user=db_user,
            password=db_password,
            db=db_name,
            minsize=1,
            maxsize=10,
            ssl=ssl_ctx,
            autocommit=True
        )

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS questions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    question_text TEXT NOT NULL,
                    question_type VARCHAR(50) NOT NULL,
                    order_index INT NOT NULL,
                    is_required BOOLEAN DEFAULT TRUE,
                    choices TEXT
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS user_sessions (
                    user_id VARCHAR(255) PRIMARY KEY,
                    current_order_index INT DEFAULT 0,
                    is_completed BOOLEAN DEFAULT FALSE,
                    updated_at BIGINT
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS user_activity (
                    user_id VARCHAR(255) PRIMARY KEY,
                    username VARCHAR(255),
                    last_online BIGINT,
                    last_notified BIGINT
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS answers (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    question_id INT NOT NULL,
                    response TEXT,
                    timestamp BIGINT
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS event_responses (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    event_name TEXT,
                    response VARCHAR(50),
                    timestamp BIGINT
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS pending_updates (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    missing_column VARCHAR(255) NOT NULL,
                    status ENUM('pending', 'asked', 'answered') DEFAULT 'pending',
                    timestamp BIGINT,
                    INDEX idx_user_status (user_id, status)
                );
            """)

            await cur.execute("""
                CREATE TABLE IF NOT EXISTS auto_updates (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    column_name VARCHAR(255) NOT NULL,
                    value TEXT,
                    timestamp BIGINT
                );
            """)

            # Seed database if questions table is empty
            await cur.execute("SELECT count(*) as count FROM questions")
            row = await cur.fetchone()
            if row and row[0] == 0:
                print('Seeding database with sample questions...')
                questions = [
                    ("Please enter your email address to get verified:", "email", 1, True, None),
                    ("What is your full name?", "text", 2, True, None),
                    ("Which of the following best describes your status with JerseySTEM?", "single_choice", 3, True, json.dumps(["Prospective Program Instructor", "Current Program Instructor", "Returning/Former Instructor"])),
                    ("If you are a PROSPECTIVE instructor, why are you interested in joining? (If not, type 'skip')", "text", 4, True, None),
                    ("If you are a CURRENT instructor, thank you for teaching! What classes are you currently teaching? (If not, type 'skip')", "text", 5, True, None),
                    ("If you are a RETURNING/FORMER instructor, good to see you back! What classes did you teach previously? (If not, type 'skip')", "text", 6, True, None)
                ]
                for q in questions:
                    await cur.execute("""
                        INSERT INTO questions (question_text, question_type, order_index, is_required, choices)
                        VALUES (%s, %s, %s, %s, %s)
                    """, q)
                print('Seeding completed.')

async def execute(query: str, params=None):
    """
    Executes a query and returns a list of dictionaries (rows) and the rowcount.
    This behaves similarly to the promise-based mysql2 client in Node.
    """
    global pool
    if pool is None:
        await init_db()
    assert pool is not None
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(query, params)
            rows = await cur.fetchall()
            return rows, cur.rowcount

def get_db():
    return pool
