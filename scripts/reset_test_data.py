import sys
import os
import pymysql
from dotenv import load_dotenv

load_dotenv()

# ADD YOUR TEST USERS HERE
TEST_USERS = [
    'taanihihi_50147',
]

cli_args = [a for a in sys.argv[1:] if not a.startswith('--')]
HANDLES_TO_RESET = cli_args if cli_args else TEST_USERS

def reset_data():
    db_host = os.getenv('DB_HOST', '127.0.0.1')
    db_port = int(os.getenv('DB_PORT', 3306))
    db_user = os.getenv('DB_USER', 'root')
    db_password = os.getenv('DB_PASSWORD', 'root')
    db_name = os.getenv('DB_NAME', 'discord_bot')
    
    ssl_ctx = None
    if db_host and db_host != '127.0.0.1':
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        conn = pymysql.connect(
            host=db_host,
            port=db_port,
            user=db_user,
            password=db_password,
            database=db_name,
            ssl=ssl_ctx,
            cursorclass=pymysql.cursors.DictCursor
        )
    except Exception as e:
        print(f"❌ Failed to connect to database: {e}")
        return

    try:
        with conn.cursor() as cur:
            # Get all tracked field names from AI_fields
            cur.execute('SELECT FIELD_NAME FROM AI_fields')
            rows = cur.fetchall()
            columns = [r['FIELD_NAME'] for r in rows]
            
            if not columns:
                print("⚠️ No fields found in AI_fields table.")
                return

            set_clauses = ', '.join(f"`{c}` = NULL" for c in columns)

            print(f"\n🔄 Resetting {len(HANDLES_TO_RESET)} test user(s)...\n")

            for handle in HANDLES_TO_RESET:
                print(f"─── {handle} ───")

                # 1. NULL out all tracked Contact fields
                query = f"UPDATE Contact SET {set_clauses} WHERE Discord_Handle__c = %s"
                affected = cur.execute(query, (handle,))
                if affected == 0:
                    print("  ⚠️  No Contact record found — skipping field reset")
                else:
                    print(f"  ✅ Nulled {len(columns)} fields in Contact")

                # 2. Reset the 48-hour cooldown
                affected_act = cur.execute(
                    'UPDATE user_activity SET last_notified = 0 WHERE username = %s',
                    (handle,)
                )
                if affected_act == 0:
                    print("  ⚠️  Not in user_activity yet — cooldown will be set on first message")
                else:
                    print("  ✅ Cooldown reset")

                # 3. Clear pending_updates queue
                cur.execute("""
                    DELETE FROM pending_updates 
                    WHERE user_id IN (
                        SELECT id FROM (
                            SELECT id FROM user_activity WHERE username = %s
                        ) AS t
                    )
                """, (handle,))
                print("  ✅ Cleared pending_updates queue\n")

            conn.commit()
            print("✨ Done! Use /audit_missing in Discord to trigger the test flow.\n")

    except Exception as e:
        print(f"❌ Error during reset: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    reset_data()
