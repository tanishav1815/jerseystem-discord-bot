import os
import asyncio
import discord
from discord.ext import commands, tasks
from dotenv import load_dotenv
from src import db
from src.form_engine import form_engine, VerifyGateView, VerifyEmailModal
from src.permissions import is_admin, deny_access

load_dotenv()

# Setup Intents
intents = discord.Intents.default()
intents.messages = True
intents.message_content = True
intents.dm_messages = True
intents.presences = True
intents.members = True  # Required to search and DM members

bot = commands.Bot(command_prefix="!", intents=intents)

# Cooldown lock for PresenceUpdate
presence_locks = set()

@bot.event
async def on_ready():
    print(f"Ready! Logged in as {bot.user}")
    
    # Register persistent button views
    bot.add_view(VerifyGateView())
    
    # Register slash commands globally
    try:
        synced = await bot.tree.sync()
        print(f"Successfully synced {len(synced)} application (/) commands.")
    except Exception as e:
        print(f"Failed to sync slash commands: {e}")
        
    # Start the 24-hour background sweep if not already running
    if not daily_audit_task.is_running():
        daily_audit_task.start()

# Slash Commands
@bot.tree.command(name="verify", description="Verify your email to unlock access to JerseySTEM channels")
async def verify(interaction: discord.Interaction):
    await interaction.response.send_modal(VerifyEmailModal())

@bot.tree.command(name="setup_verification", description="Post the official Verification Gate card and button in this channel (Admin only)")
async def setup_verification(interaction: discord.Interaction):
    if not is_admin(interaction):
        return await deny_access(interaction)
    
    embed = discord.Embed(
        title="🌟 Welcome to JerseySTEM! 🌟",
        description=(
            "Welcome to the official JerseySTEM Discord community!\n\n"
            "**To unlock access to our channels and discussions:**\n"
            "1. Click the **Verify Email to Unlock Channels** button below.\n"
            "2. Enter your valid email address in the pop-up.\n"
            "3. Your **Validated Visitor** access will be granted instantly!\n\n"
            "🔒 *General channels & community categories are unlocked upon verification.*"
        ),
        color=0x00AE86
    )
    embed.set_footer(text="JerseySTEM Community Gate")
    if isinstance(interaction.channel, discord.abc.Messageable):
        await interaction.channel.send(embed=embed, view=VerifyGateView())
    await interaction.response.send_message("✅ Verification Gate posted successfully!", ephemeral=True)

@bot.tree.command(name="start", description="Start the onboarding questionnaire")
async def start(interaction: discord.Interaction):
    await form_engine.start_form(interaction.user, interaction)

@bot.tree.command(name="sync", description="Sync questions from Google Sheets")
async def sync(interaction: discord.Interaction):
    if not is_admin(interaction):
        return await deny_access(interaction)
    await form_engine.sync_questions(interaction)

@bot.tree.command(name="ask", description="Ask a question using the knowledge base")
@discord.app_commands.describe(query="The question you want to ask")
async def ask(interaction: discord.Interaction, query: str):
    await form_engine.ask_question(interaction, query)

@bot.tree.command(name="announce", description="Announce an event and collect Accept/Decline responses")
@discord.app_commands.describe(event="The name or description of the event")
async def announce(interaction: discord.Interaction, event: str):
    if not is_admin(interaction):
        return await deny_access(interaction)
    await form_engine.announce_event(interaction, event)

@bot.tree.command(name="menu", description="Send the Main Navigation Menu")
async def menu(interaction: discord.Interaction):
    await form_engine.send_main_menu(interaction)

@bot.tree.command(name="audit_missing", description="Manually force a scan of all known users for missing information and ping them")
async def audit_missing(interaction: discord.Interaction):
    if not is_admin(interaction):
        return await deny_access(interaction)
    await interaction.response.send_message("🔍 Starting background audit of all users...", ephemeral=True)
    asyncio.create_task(form_engine.audit_all_users(bot))
    await interaction.followup.send("✅ Finished dispatching background missing information requests!", ephemeral=True)

# Global Interaction Handler (for Buttons/Selects/Modals)
@bot.event
async def on_interaction(interaction: discord.Interaction):
    # Slash commands and modals handle themselves
    if interaction.type in (discord.InteractionType.application_command, discord.InteractionType.modal_submit):
        return
    await form_engine.handle_interaction(interaction)

# Member Join Event Handler
@bot.event
async def on_member_join(member: discord.Member):
    if member.bot:
        return
    print(f"DEBUG: Member joined: {member.name} ({member.id})")
    session = await form_engine.get_user_session(str(member.id))
    if not session or not session.get('is_completed'):
        try:
            await member.send("🌟 **Welcome to the JerseySTEM Community!** 🌟\n\nWe are excited to have you here. To get verified and unlock channel access, please take 30 seconds to answer our quick onboarding questionnaire below:")
            await form_engine.start_form(member, member)
        except Exception as e:
            print(f"Could not send welcome DM to joining member {member.name}: {e}")

# Message Event Handler
@bot.event
async def on_message(message: discord.Message):
    print(f"DEBUG: Message received from {message.author}: {message.content} (is_dm: {message.guild is None})")
    if message.author.bot:
        return

    # 1. Proactively check if user online activity triggers missing tasks
    print("DEBUG: Calling handle_user_online...")
    handled_proactive = await form_engine.handle_user_online(message.author)
    print(f"DEBUG: handle_user_online returned {handled_proactive}")
    if handled_proactive:
        return

    # Check if user is in a session
    print("DEBUG: Fetching user session...")
    session = await form_engine.get_user_session(str(message.author.id))
    print(f"DEBUG: Found session: {session}")

    # Auto-Welcome & Onboarding trigger
    if not session:
        try:
            print("DEBUG: No session. Sending welcome message...")
            await message.author.send("🌟 **Welcome to the JerseySTEM Community!** 🌟\n\nWe are incredibly excited to have you here. To set up your profile, please take 30 seconds to answer our quick onboarding questionnaire below:")
            await form_engine.start_form(message.author, message.author)
        except Exception as e:
            print(f"Could not send welcome message to {message.author.name}: {e}")
        return

    if session['is_completed']:
        # 1. Check if they are answering a Missing Info question (Two-Way Sync)
        print("DEBUG: Session is completed. Checking for pending updates...")
        rows, _ = await db.execute(
            "SELECT * FROM pending_updates WHERE user_id = %s AND status = 'asked' ORDER BY id ASC LIMIT 1",
            (str(message.author.id),)
        )
        if rows:
            print(f"DEBUG: User is answering a missing info question: {rows[0]['missing_column']}")
            await form_engine.handle_two_way_sync(message, rows[0]['missing_column'])
            return

        # 2. Standard Chatbot 
        is_dm = message.guild is None
        is_mentioned = bot.user in message.mentions if bot.user else False
        print(f"DEBUG: Standard chatbot. is_dm={is_dm}, is_mentioned={is_mentioned}")
        if is_dm or is_mentioned:
            # Strip out bot mention
            query = message.content
            if bot.user:
                query = query.replace(f"<@{bot.user.id}>", "").strip()
                query = query.replace(f"<@!{bot.user.id}>", "").strip()
            if query:
                print(f"DEBUG: Calling ask_question with query: {query}")
                await form_engine.ask_question(message, query)
        return

    # Process active onboarding question text response
    questions = await form_engine.get_sorted_questions()
    current_q = next((q for q in questions if q['order_index'] == session['current_order_index']), None)

    if current_q and current_q['question_type'] == 'text':
        result = await form_engine.handle_input(message.author, message.content, 'text')
        if isinstance(result, str):
            await message.reply(result)
        elif result and result.get('next'):
            await form_engine.send_question(message.author, message.channel, result['next'])
        elif result and result.get('finished'):
            await message.channel.send(f"Thank you {message.author.name}, you have completed the form!")

# Presence Update Handler
@bot.event
async def on_presence_update(before: discord.Member, after: discord.Member):
    try:
        was_offline = (before.status == discord.Status.offline) if before is not None else True
        is_now_online = after.status != discord.Status.offline
        if not was_offline or not is_now_online:
            return

        user = after
        if not user or user.bot:
            return

        # Cooldown logic (10s)
        if user.id in presence_locks:
            return
        presence_locks.add(user.id)
        
        async def clear_lock(uid):
            await asyncio.sleep(10)
            presence_locks.discard(uid)
        asyncio.create_task(clear_lock(user.id))

        # Send welcome DM
        try:
            await user.send(f"👋 Hey {user.name}, welcome back! Great to see you online. 🌟")
        except Exception as dm_err:
            print(f"Could not DM {user.name} on login: {dm_err}")

        # Trigger proactive check
        await form_engine.handle_user_online(user)

    except Exception as e:
        print(f"PresenceUpdate error: {e}")

# Daily Cron sweep
@tasks.loop(hours=24)
async def daily_audit_task():
    print("Triggering 24-hr CRON sweep for missing information...")
    await form_engine.audit_all_users(bot)

# Main Application Bootstrapper
async def main():
    await db.init_db()
    print('Database connected correctly.')
    
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        print("Error: DISCORD_TOKEN is missing in environment variables.")
        return
    await bot.start(token)

if __name__ == "__main__":
    asyncio.run(main())
