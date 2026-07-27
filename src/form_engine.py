import os
import json
import random
import httpx
import discord
from typing import Any
from google import genai
from src import db
from src.permissions import is_admin

# Define Modal classes first so they can be referenced inside FormEngine or Views
class AskModal(discord.ui.Modal, title='Ask the Knowledge Base'):
    query_input = discord.ui.TextInput(
        label='What is your question?',
        style=discord.TextStyle.paragraph,
        placeholder='Type your question here...',
        required=True,
        custom_id='query_input'
    )

    async def on_submit(self, interaction: discord.Interaction):
        await form_engine.ask_question(interaction, self.query_input.value)

class AnnounceModal(discord.ui.Modal, title='Create New Event'):
    event_input = discord.ui.TextInput(
        label='What is the name of the event?',
        style=discord.TextStyle.short,
        placeholder='e.g., Fall 2026 Instructor Meetup',
        required=True,
        custom_id='event_input'
    )

    async def on_submit(self, interaction: discord.Interaction):
        await form_engine.announce_event(interaction, self.event_input.value)

class DynamicGroupModal(discord.ui.Modal):
    def __init__(self, title, fields, current_values):
        super().__init__(title=title[:45])
        self.fields_to_check = fields[:5]
        self.inputs = {}
        for f in self.fields_to_check:
            col_name = f['FIELD_NAME']
            label = f['FIELD_LABEL']
            existing_val = current_values.get(col_name)
            has_val = existing_val is not None and str(existing_val).strip() != ''
            
            placeholder = f"Current: {str(existing_val).strip()}" if has_val else f"Enter your {label}"
            default_val = str(existing_val).strip() if has_val else None
            
            text_input = discord.ui.TextInput(
                label=label[:45],
                style=discord.TextStyle.short,
                required=(f['LEVEL'] == 'Required' and not has_val),
                placeholder=placeholder[:100],
                default=default_val[:4000] if default_val else None,
                custom_id=f"gf_{col_name}"
            )
            self.add_item(text_input)
            self.inputs[col_name] = text_input

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        saved = 0
        errors = []
        for col_name, text_input in self.inputs.items():
            val = text_input.value.strip() if text_input.value else None
            if not val:
                continue
            try:
                await form_engine._update_contact_by_column_name(interaction.user, col_name, val)
                saved += 1
            except Exception as e:
                errors.append(col_name)
                print(f"Failed to save {col_name}: {e}")
                
        if saved > 0:
            msg = f"✅ Saved **{saved}** field(s) to your profile!"
            if errors:
                msg += f"\n⚠️ Could not save: {', '.join(errors)}"
        else:
            msg = "⚠️ No fields were saved. Please fill in at least one field."
            
        await interaction.followup.send(content=msg, ephemeral=True)

class MainMenuView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label='Start Questionnaire', style=discord.ButtonStyle.primary, emoji='📋', custom_id='menu_start')
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        await form_engine.start_form(interaction.user, interaction)

    @discord.ui.button(label='Ask a Question', style=discord.ButtonStyle.success, emoji='💡', custom_id='menu_ask')
    async def ask(self, interaction: discord.Interaction, button: discord.ui.Button):
        await form_engine.handle_main_menu_click(interaction)

    @discord.ui.button(label='Announce Event', style=discord.ButtonStyle.danger, emoji='📢', custom_id='menu_announce')
    async def announce(self, interaction: discord.Interaction, button: discord.ui.Button):
        await form_engine.handle_main_menu_click(interaction)

    @discord.ui.button(label='Sync Database', style=discord.ButtonStyle.secondary, emoji='🔄', custom_id='menu_sync')
    async def sync(self, interaction: discord.Interaction, button: discord.ui.Button):
        await form_engine.sync_questions(interaction)

class FormEngine:
    def __init__(self):
        self.online_locks = set()
        
        self.group_slugs = {
            'School & Education': 'school_education',
            'Teaching Info': 'teaching_info',
            'Availability & Transport': 'availability_transport',
            'JerseySTEM Role': 'jerseySTEM_role',
            'Personal & Profile': 'personal_profile'
        }
        self.slug_to_group = {v: k for k, v in self.group_slugs.items()}
        self.group_emojis = {
            'School & Education': '🎓',
            'Teaching Info': '📚',
            'Availability & Transport': '🚗',
            'JerseySTEM Role': '⭐',
            'Personal & Profile': '👤'
        }
        self.field_options = {
            't-shirt_size(adult)': { 'type': 'buttons', 'label': 'T-Shirt Size', 'choices': ['XS', 'S', 'M', 'L', 'XL'] },
            't-shirt size': { 'type': 'buttons', 'label': 'T-Shirt Size', 'choices': ['XS', 'S', 'M', 'L', 'XL'] },
            'school email': { 'type': None, 'label': 'School Email' },
            'graduation year': { 'type': 'dropdown', 'label': 'Graduation Year', 'choices': ['2024', '2025', '2026', '2027', '2028', '2029'] }
        }

    def _get_fallback_message(self, field_name, remaining):
        transitions = [
            f"Next up — what's your **{field_name}**? 📝",
            f"Almost there! Could you share your **{field_name}**? ✨",
            f"Moving along! 🚀 What's your **{field_name}**?",
            f"One more thing — your **{field_name}**? 😊",
            f"Quick one — what about your **{field_name}**? 🎯",
            f"And your **{field_name}**? 💬",
            f"Let's keep going! What's your **{field_name}**? 🙌"
        ]
        msg = random.choice(transitions)
        if remaining > 1:
            msg += f" ({remaining} more after this)"
        return msg

    async def _get_smart_message(self, prompt, field_name, remaining):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return self._get_fallback_message(field_name, remaining)
        try:
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
            )
            if response.text:
                return response.text.strip()
            return self._get_fallback_message(field_name, remaining)
        except Exception as e:
            print(f"Gemini rate limited or error, using fallback for {field_name}: {e}")
            return self._get_fallback_message(field_name, remaining)

    def _parse_choices(self, choices_str):
        if not choices_str:
            return []
        try:
            return json.loads(choices_str)
        except Exception:
            clean = choices_str.replace('[', '').replace(']', '')
            return [s.strip() for s in clean.split(',') if s.strip()]

    async def send_main_menu(self, interaction: discord.Interaction):
        bot_user = interaction.client.user
        bot_avatar = bot_user.display_avatar.url if bot_user else None
        embed = discord.Embed(
            title='🌟 Welcome to the Community!',
            description='We are incredibly excited to have you here.\n\nTo ensure you get the absolute most out of your experience and are placed in the right programs, please select an option from the menu below!',
            color=0x00B0F0
        )
        embed.set_image(url='https://images.unsplash.com/photo-1522071820081-009f0129c71c?q=80&w=2070&auto=format&fit=crop')
        if bot_avatar:
            embed.set_thumbnail(url=bot_avatar)
        embed.add_field(name='📋 Step 1: Onboarding', value='Click **Start Questionnaire** to set up your profile and preferences.', inline=True)
        embed.add_field(name='💡 Step 2: Learn More', value='Click **Ask a Question** to search our official Knowledge Base.', inline=True)
        embed.add_field(name='🛠️ Step 3: Admin Tools', value='Use the buttons below to announce new events or sync data.', inline=False)
        if bot_avatar:
            embed.set_footer(text='Community Support Bot', icon_url=bot_avatar)
        else:
            embed.set_footer(text='Community Support Bot')

        view = MainMenuView()
        await interaction.response.send_message(embed=embed, view=view)

    async def handle_main_menu_click(self, interaction: discord.Interaction):
        custom_id = interaction.data.get('custom_id', '') if interaction.data else ''
        if custom_id == 'menu_start':
            await self.start_form(interaction.user, interaction)
        elif custom_id == 'menu_ask':
            await interaction.response.send_modal(AskModal())
        elif custom_id == 'menu_announce':
            from src.permissions import is_admin, deny_access
            if not is_admin(interaction):
                return await deny_access(interaction)
            await interaction.response.send_modal(AnnounceModal())
        elif custom_id == 'menu_sync':
            await self.sync_questions(interaction)

    async def get_context_data(self):
        doc_ids_env = os.getenv("GOOGLE_DOC_IDS") or os.getenv("GOOGLE_DOC_ID")
        sheet_ids_env = os.getenv("GOOGLE_SHEET_IDS")
        combined_doc_text = ''

        async with httpx.AsyncClient(follow_redirects=True) as client:
            # 1. Download text from Google Docs
            if doc_ids_env:
                doc_ids = [id.strip() for id in doc_ids_env.split(',') if id.strip()]
                for doc_id in doc_ids:
                    try:
                        doc_url = f"https://docs.google.com/document/export?format=txt&id={doc_id}"
                        response = await client.get(doc_url)
                        if response.status_code == 200:
                            combined_doc_text += f"--- Google Document ID: {doc_id} ---\n{response.text}\n\n"
                    except Exception as err:
                        print(f"Error fetching Google Doc {doc_id}: {err}")

            # 2. Download text from Google Sheets
            if sheet_ids_env:
                sheet_ids = [id.strip() for id in sheet_ids_env.split(',') if id.strip()]
                for sheet_entry in sheet_ids:
                    try:
                        sheet_id = sheet_entry
                        gid = '0'
                        if '|' in sheet_entry:
                            sheet_id, gid = sheet_entry.split('|')
                        sheet_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
                        response = await client.get(sheet_url)
                        if response.status_code == 200:
                            combined_doc_text += f"--- Google Sheet (CSV Format) ---\n{response.text}\n\n"
                    except Exception as err:
                        print(f"Error fetching Google Sheet {sheet_entry}: {err}")

        # 3. Live Database Context
        # 3A. User name mappings
        try:
            rows, _ = await db.execute("""
                SELECT a.user_id, q.question_text, a.response
                FROM answers a
                JOIN questions q ON a.question_id = q.id
                WHERE LOWER(q.question_text) LIKE '%name%'
            """)
            db_context = "--- User Name Mappings from Database ---\n"
            for a in rows:
                db_context += f"Discord ID: {a['user_id']} | Real Name: {a['response']}\n"
            combined_doc_text += db_context + "\n"
        except Exception as e:
            print(f"MySQL Name mapping fetch skipped: {e}")

        # 3B. Members table
        try:
            rows, _ = await db.execute('SELECT username, nickName FROM Members LIMIT 200')
            if rows:
                members_context = "--- JerseySTEM Discord Members ---\n"
                for m in rows:
                    discord = m.get('username') or m.get('nickName') or 'N/A'
                    members_context += f"Discord Handle: {discord}\n"
                combined_doc_text += members_context + "\n"
        except Exception as e:
            print(f"MySQL Members context fetch skipped: {e}")

        # 3C. Contact table
        try:
            rows, _ = await db.execute("""
                SELECT FirstName, LastName, Discord_Handle__c, Email,
                       T_Shirt_Size__c, School_Email__c, Graduation_Year__c,
                       JerseySTEM_Department__c, JerseySTEM_Role__c
                FROM Contact
                WHERE Discord_Handle__c IS NOT NULL
                LIMIT 200
            """)
            if rows:
                contacts_context = "--- JerseySTEM Contact Profiles (from Live Database) ---\n"
                for c in rows:
                    first = c.get('FirstName') or ''
                    last = c.get('LastName') or ''
                    name = f"{first} {last}".strip()
                    contacts_context += f"Name: {name}"
                    if c.get('Discord_Handle__c'): contacts_context += f" | Discord: {c['Discord_Handle__c']}"
                    if c.get('Email'): contacts_context += f" | Email: {c['Email']}"
                    if c.get('T_Shirt_Size__c'): contacts_context += f" | T-Shirt: {c['T_Shirt_Size__c']}"
                    if c.get('School_Email__c'): contacts_context += f" | School Email: {c['School_Email__c']}"
                    if c.get('Graduation_Year__c'): contacts_context += f" | Grad Year: {c['Graduation_Year__c']}"
                    if c.get('JerseySTEM_Department__c'): contacts_context += f" | Dept: {c['JerseySTEM_Department__c']}"
                    if c.get('JerseySTEM_Role__c'): contacts_context += f" | Role: {c['JerseySTEM_Role__c']}"
                    contacts_context += '\n'
                combined_doc_text += contacts_context + "\n"
        except Exception as e:
            print(f"MySQL Contact context fetch skipped: {e}")

        return combined_doc_text

    async def handle_user_online(self, user: discord.User | discord.Member, force=False):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return False

        if user.id in self.online_locks:
            return False
        self.online_locks.add(user.id)

        now = int(discord.utils.utcnow().timestamp() * 1000)
        cooldown = 24 * 60 * 60 * 1000

        try:
            rows, _ = await db.execute('SELECT * FROM user_activity WHERE user_id = %s', (str(user.id),))
            activity = rows[0] if rows else None

            if not force and activity and activity.get('last_notified') and (now - activity['last_notified'] < cooldown):
                await db.execute('UPDATE user_activity SET last_online = %s WHERE user_id = %s', (now, str(user.id)))
                return False

            if not activity:
                await db.execute("""
                    INSERT INTO user_activity (user_id, username, last_online, last_notified)
                    VALUES (%s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE last_online=VALUES(last_online), last_notified=VALUES(last_notified)
                """, (str(user.id), user.name, now, now))
            else:
                await db.execute('UPDATE user_activity SET last_online = %s, last_notified = %s WHERE user_id = %s', (now, now, str(user.id)))

            real_name = None
            discord_handle = None

            try:
                member_rows, _ = await db.execute(
                    'SELECT username FROM Members WHERE username = %s OR nickName = %s',
                    (user.name, user.name)
                )
                if member_rows:
                    discord_handle = member_rows[0]['username']
            except Exception as e:
                print(f"Members lookup error: {e}")

            if not discord_handle:
                try:
                    name_rows, _ = await db.execute("""
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = %s AND LOWER(q.question_text) LIKE '%%name%%'
                        LIMIT 1
                    """, (str(user.id),))
                    if name_rows and name_rows[0].get('response'):
                        real_name = name_rows[0]['response'].strip()
                except Exception as e:
                    print(f"Name lookup error: {e}")

                if not real_name:
                    print(f"Could not identify {user.name} in Contact or Members table. Skipping.")
                    return False

            contact_row = None
            try:
                if discord_handle:
                    contact_rows, _ = await db.execute(
                        'SELECT * FROM Contact WHERE Discord_Handle__c = %s LIMIT 1',
                        (discord_handle,)
                    )
                    if contact_rows:
                        contact_row = contact_rows[0]
                        real_name = contact_row.get('FirstName') or contact_row.get('Name') or discord_handle

                if not contact_row and real_name:
                    contact_rows, _ = await db.execute(
                        'SELECT * FROM Contact WHERE FirstName LIKE %s OR Name LIKE %s LIMIT 1',
                        (f"%{real_name}%", f"%{real_name}%")
                    )
                    if contact_rows:
                        contact_row = contact_rows[0]
                        real_name = contact_row.get('FirstName') or contact_row.get('Name') or real_name
            except Exception as e:
                print(f"Contact lookup error: {e}")

            if not contact_row:
                print(f"No Contact record found for {user.name} ({real_name or 'unknown'}). Skipping.")
                return False

            missing_fields = []
            try:
                ai_fields, _ = await db.execute("""
                    SELECT FIELD_NAME, FIELD_LABEL, LEVEL, GROUP_NAME, SORT_ORDER
                    FROM AI_fields
                    ORDER BY
                      CASE LEVEL WHEN 'Required' THEN 1 WHEN 'optional' THEN 2 WHEN 'nice to have' THEN 3 ELSE 4 END,
                      GROUP_NAME, SORT_ORDER
                """)

                for field in ai_fields:
                    col_name = field['FIELD_NAME']
                    val = contact_row.get(col_name)
                    if val is None or str(val).strip() == '':
                        missing_fields.append({
                            'column': col_name,
                            'label': field['FIELD_LABEL'],
                            'level': field['LEVEL'],
                            'group': field.get('GROUP_NAME') or 'General'
                        })
                print(f"AI_fields scan for {real_name}: {len(missing_fields)} missing out of {len(ai_fields)} fields")
            except Exception as e:
                print(f"AI_fields scan error: {e}")

            existing_pending, _ = await db.execute(
                "SELECT * FROM pending_updates WHERE user_id = %s AND status IN ('pending', 'asked')",
                (str(user.id),)
            )

            if existing_pending:
                next_q = existing_pending[0]
                if next_q['status'] == 'pending':
                    await db.execute("UPDATE pending_updates SET status = 'asked' WHERE id = %s", (next_q['id'],))

                prompt = f"You are a friendly, casual Discord bot for JerseySTEM. Write a SHORT (under 40 words), natural-sounding DM asking the user \"{real_name}\" for their \"{next_q['missing_column']}\". Be conversational, use an emoji, and do NOT start with \"Hey\". Just ask the question naturally like a friend texting."
                intro_text = await self._get_smart_message(prompt, next_q['missing_column'], len(existing_pending))
                await self.send_missing_field_question(user, next_q['missing_column'], intro_text)
                print(f"Re-asked {user.name} about: {next_q['missing_column']}")
                return True

            if len(missing_fields) == 0:
                print(f"{user.name} ({real_name}) has no missing fields.")
                return False

            grouped_fields = {}
            for field in missing_fields:
                g = field['group'] or 'General'
                if g not in grouped_fields:
                    grouped_fields[g] = []
                grouped_fields[g].append(field)

            await self.send_grouped_missing_embed(user, grouped_fields, real_name)
            return True

        except Exception as e:
            print(f"handle_user_online Error: {e}")
            return False
        finally:
            self.online_locks.discard(user.id)

    async def send_grouped_missing_embed(self, user: discord.User | discord.Member, grouped_fields, real_name):
        group_names = list(grouped_fields.keys())
        total_missing = sum(len(arr) for arr in grouped_fields.values())

        all_fields_by_group = {}
        try:
            all_fields, _ = await db.execute(
                'SELECT FIELD_NAME, FIELD_LABEL, LEVEL, GROUP_NAME FROM AI_fields ORDER BY GROUP_NAME, SORT_ORDER'
            )
            member_rows, _ = await db.execute(
                'SELECT username FROM Members WHERE username = %s OR nickName = %s LIMIT 1',
                (user.name, user.name)
            )
            handle = member_rows[0]['username'] if member_rows else user.name
            contact_rows, _ = await db.execute(
                'SELECT * FROM Contact WHERE Discord_Handle__c = %s LIMIT 1', (handle,)
            )
            contact = contact_rows[0] if contact_rows else {}

            for f in all_fields:
                g = f['GROUP_NAME'] or 'General'
                if g not in all_fields_by_group:
                    all_fields_by_group[g] = []
                val = contact.get(f['FIELD_NAME'])
                filled = val is not None and str(val).strip() != ''
                all_fields_by_group[g].append({
                    **f,
                    'filled': filled,
                    'currentValue': str(val).strip() if filled else None
                })
        except Exception as e:
            print(f"Detailed field status fetch skipped: {e}")
            all_fields_by_group = grouped_fields

        embed = discord.Embed(
            title='📋 Your JerseySTEM Profile Status',
            description=(
                f"Hi **{real_name}**! 👋 You have **{total_missing} missing field(s)** to complete.\n\n"
                "Click a button below to fill in a section. Fields marked ✅ are already saved! ✨"
            ),
            color=0x00B0F0
        )

        for group_name, fields in all_fields_by_group.items():
            if group_name not in grouped_fields:
                continue
            emoji = self.group_emojis.get(group_name, '📝')
            field_lines = []
            for f in fields:
                is_filled = f.get('filled', False)
                label = f.get('FIELD_LABEL') or f.get('label')
                level = f.get('LEVEL') or f.get('level')
                if is_filled:
                    field_lines.append(f"✅ ~~{label}~~")
                else:
                    req_star = ' *(required)*' if level == 'Required' else ''
                    field_lines.append(f"❌ {label}{req_star}")
            embed.add_field(name=f"{emoji} {group_name}", value='\n'.join(field_lines), inline=True)

        view = discord.ui.View(timeout=None)
        for group_name in group_names:
            slug = self.group_slugs.get(group_name) or group_name.replace(' ', '_').lower()
            emoji = self.group_emojis.get(group_name, '📝')
            btn = discord.ui.Button(
                style=discord.ButtonStyle.primary,
                label=f"{emoji} {group_name}",
                custom_id=f"group_btn_{slug}"
            )
            view.add_item(btn)

        try:
            await user.send(embed=embed, view=view)
        except Exception as e:
            print(f"Could not DM grouped embed to {user.name}: {e}")

    async def handle_group_button_click(self, interaction: discord.Interaction):
        data = interaction.data
        if not isinstance(data, dict):
            return
        custom_id = data.get('custom_id', '')
        if not isinstance(custom_id, str):
            custom_id = ''
        slug = custom_id.replace('group_btn_', '')
        group_name = self.slug_to_group.get(slug)
        if not group_name:
            return await interaction.response.send_message('❌ Unknown group. Please try again.', ephemeral=True)

        ai_fields, _ = await db.execute(
            'SELECT FIELD_NAME, FIELD_LABEL, LEVEL FROM AI_fields WHERE GROUP_NAME = %s ORDER BY SORT_ORDER',
            (group_name,)
        )
        if not ai_fields:
            return await interaction.response.send_message('⚠️ No fields configured for this group.', ephemeral=True)

        current_values = {}
        try:
            member_rows, _ = await db.execute(
                'SELECT username FROM Members WHERE username = %s OR nickName = %s LIMIT 1',
                (interaction.user.name, interaction.user.name)
            )
            handle = member_rows[0]['username'] if member_rows else interaction.user.name
            contact_rows, _ = await db.execute(
                'SELECT * FROM Contact WHERE Discord_Handle__c = %s LIMIT 1', (handle,)
            )
            if contact_rows:
                current_values = contact_rows[0]
        except Exception as e:
            print(f"Could not pre-populate contact fields: {e}")

        emoji = self.group_emojis.get(group_name, '📝')
        await interaction.response.send_modal(DynamicGroupModal(f"{emoji} {group_name}", ai_fields, current_values))

    async def _update_contact_by_column_name(self, discord_user, column_name, value):
        valid_fields, _ = await db.execute(
            'SELECT FIELD_NAME FROM AI_fields WHERE FIELD_NAME = %s LIMIT 1',
            (column_name,)
        )
        if not valid_fields:
            raise ValueError(f"Column '{column_name}' not in AI_fields")

        member_rows, _ = await db.execute(
            'SELECT username FROM Members WHERE username = %s OR nickName = %s LIMIT 1',
            (discord_user.name, discord_user.name)
        )
        discord_handle = member_rows[0]['username'] if member_rows else discord_user.name

        query = f"UPDATE Contact SET `{column_name}` = %s WHERE Discord_Handle__c = %s LIMIT 1"
        await db.execute(query, (value, discord_handle))

        await db.execute(
            'INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (%s, %s, %s, %s)',
            (str(discord_user.id), column_name, value, int(discord.utils.utcnow().timestamp() * 1000))
        )
        print(f"[GroupModal] {discord_user.name}: {column_name} = \"{value}\"")

    async def send_missing_field_question(self, target, field_name, intro_text):
        field_key = field_name.lower().strip()
        field_config = self.field_options.get(field_key)

        if not field_config or not field_config.get('type'):
            await target.send(intro_text)
            return

        view = discord.ui.View(timeout=None)
        embed = discord.Embed(
            title=f"📋 {field_config['label']}",
            description=intro_text,
            color=0x5865F2
        )

        choices = field_config.get('choices') or []

        if field_config['type'] == 'buttons' and len(choices) <= 5:
            for idx, choice in enumerate(choices):
                btn = discord.ui.Button(
                    style=discord.ButtonStyle.secondary,
                    label=choice,
                    custom_id=f"missing_btn_{idx}_{choice}"
                )
                view.add_item(btn)
        else:
            select = discord.ui.Select(
                custom_id='missing_select',
                placeholder=f"Select your {field_config['label']}...",
                options=[
                    discord.SelectOption(label=c, value=c)
                    for c in choices
                ]
            )
            view.add_item(select)

        await target.send(embed=embed, view=view)

    async def ask_question(self, interaction_or_message, query):
        doc_ids_env = os.getenv("GOOGLE_DOC_IDS") or os.getenv("GOOGLE_DOC_ID")
        sheet_ids_env = os.getenv("GOOGLE_SHEET_IDS")

        if not doc_ids_env and not sheet_ids_env:
            msg = "Knowledge base Document or Sheet IDs not configured."
            if isinstance(interaction_or_message, discord.Interaction):
                await interaction_or_message.response.send_message(msg, ephemeral=True)
            else:
                await interaction_or_message.reply(msg)
            return

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            msg = "Gemini API Key not configured."
            if isinstance(interaction_or_message, discord.Interaction):
                await interaction_or_message.response.send_message(msg, ephemeral=True)
            else:
                await interaction_or_message.reply(msg)
            return

        is_interaction = isinstance(interaction_or_message, discord.Interaction)
        
        # RBAC Check
        user_is_admin = is_admin(interaction_or_message) if is_interaction else False
        asker_username = interaction_or_message.user.name if is_interaction else interaction_or_message.author.name
        user_id = interaction_or_message.user.id if is_interaction else interaction_or_message.author.id
        author_name = interaction_or_message.user.name if is_interaction else interaction_or_message.author.name

        print(f"DEBUG: ask_question started for user {asker_username} with query: {query}")

        rbac_instruction = (
            "The user asking is an ADMIN — they may retrieve information about ANY member, including personal data (emails, T-shirt sizes, school info, background)."
            if user_is_admin
            else f"The user asking is a PROGRAM INSTRUCTOR (username: {asker_username}). They may ONLY retrieve information about themselves. If the question appears to ask about another specific member's personal data (email, phone, T-shirt size, background info), respond with: \"I can only show you your own profile information. Please contact an Admin for other members' data.\" — do NOT reveal that data."
        )

        if is_interaction:
            await interaction_or_message.response.defer()

        async def process_and_reply():
            try:
                print("DEBUG: Fetching context data from Google Docs/Sheets/DB...")
                combined_doc_text = await self.get_context_data()
                print(f"DEBUG: Context data fetched. Length: {len(combined_doc_text)} characters.")

                chat_history_transcript = ''
                if interaction_or_message.channel:
                    try:
                        messages = []
                        async for m in interaction_or_message.channel.history(limit=15):
                            messages.append(m)
                        messages.reverse()
                        chat_history_transcript = '\n'.join(f"{m.author.name}: {m.content}" for m in messages)
                    except Exception as history_err:
                        print(f"Could not fetch history: {history_err}")

                prompt = f"""
                You are **DisBot**, JerseySTEM's friendly and knowledgeable community assistant. JerseySTEM is a non-profit STEM education organization connecting students, instructors, mentors, and volunteers.

                Your personality:
                - Warm, encouraging, and professional — like a helpful team coordinator
                - Keep responses concise unless detail is truly needed
                - For greetings (hi, hello, hey), respond briefly and offer to help with JerseySTEM topics
                - For off-topic questions (general trivia, homework help), politely say: "I'm best at helping with JerseySTEM info — members, events, programs, or profiles!"
                - Never make up data. If you don't know, say so clearly.

                Use the Knowledge Base below to answer questions. Do NOT rigidly repeat it verbatim — respond naturally.
                Do not say "I don't have enough information" if you can infer from the recent chat history.

                --- ACCESS CONTROL POLICY ---
                {rbac_instruction}
                -----------------------------

                CRITICAL SHEET INSTRUCTION: When reading the "Event Participation" spreadsheet (GID 103041255):
                - If a person has a "Y" under an event/date, they attended. 
                - If the cell under an event/date is blank (empty) or "N" for a person, it means they DID NOT attend that event! Do not say "not enough information", explicitly answer that they did not attend/were not present.

                CRITICAL RESPONSE FORMAT: You MUST ALWAYS output your response as a valid JSON object. Do not output raw text or markdown blocks.
                The JSON MUST have this exact structure:
                {{
                  "message": "The natural, conversational text you want to reply back to the user",
                  "update_sheet": true or false, // ONLY set to true if the user uses a VERY EXPLICIT command like "update my T-shirt size to L" or "set Jake's graduation year to 2026". NEVER set this to true for greetings, questions, or general conversation.
                  "update_column": "The exact column name to update, ONLY if update_sheet is true",
                  "update_value": "The resolved value, ONLY if update_sheet is true",
                  "target_user": "The name of the person to update. null if the user is referring to themselves."
                }}
                CRITICAL: update_sheet must be FALSE for: greetings, questions, general chat, asking for information, or any message that is NOT a clear explicit update command.

                --- RECENT CHAT HISTORY ---
                {chat_history_transcript}
                ---------------------------

                --- KNOWLEDGE BASE START ---
                {combined_doc_text}
                --- KNOWLEDGE BASE END ---

                User Question: {query}
                """

                print("DEBUG: Sending request to Gemini API (gemini-2.5-flash)...")
                client = genai.Client(api_key=api_key)
                response = await client.aio.models.generate_content(
                    model='gemini-2.5-flash',
                    contents=prompt,
                )
                print("DEBUG: Gemini response received successfully.")

                ai_text = response.text.strip() if response.text else "{}"
                ai_text = ai_text.replace('```json', '').replace('```', '').strip()

                message_to_send = ai_text
                do_update = False
                update_col = ''
                update_val = ''
                target_user_match = None

                try:
                    json_obj = json.loads(ai_text)
                    message_to_send = json_obj.get('message', ai_text)
                    if json_obj.get('update_sheet'):
                        do_update = True
                        update_col = json_obj.get('update_column')
                        update_val = json_obj.get('update_value')
                        target_user_match = json_obj.get('target_user')
                except Exception as e:
                    print(f"DEBUG: Parsing JSON response from Gemini failed: {e}")
                    message_to_send = ai_text

                print(f"DEBUG: Replying to user with message: {message_to_send}")
                if is_interaction:
                    await interaction_or_message.followup.send(message_to_send)
                else:
                    await interaction_or_message.reply(message_to_send)

                if do_update and update_col and update_val:
                    try:
                        payload = {
                            'action': 'update_missing_info',
                            'user_id': str(user_id),
                            'username': target_user_match if target_user_match else author_name,
                            'column': update_col,
                            'value': update_val,
                            'timestamp': discord.utils.utcnow().isoformat()
                        }
                        webhook_url = os.getenv("WEBHOOK_URL")
                        if webhook_url:
                            async with httpx.AsyncClient() as client_http:
                                await client_http.post(webhook_url, json=payload)

                        await db.execute(
                            'INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (%s, %s, %s, %s)',
                            (str(user_id), update_col, update_val, int(discord.utils.utcnow().timestamp() * 1000))
                        )
                        print(f"Silent auto-update: {update_col} = {update_val} for {author_name}")
                    except Exception as sync_err:
                        print(f"Failed to sync AI response: {sync_err}")

            except Exception as error:
                print(f"Ask error: {error}")
                err_msg = str(error)
                is_503 = '503' in err_msg or 'UNAVAILABLE' in err_msg
                user_msg = (
                    '⏳ The AI is currently busy due to high demand. Please try again in sometime!'
                    if is_503
                    else 'Sorry, I encountered an error trying to process your question.'
                )
                if is_interaction:
                    await interaction_or_message.followup.send(user_msg)
                else:
                    await interaction_or_message.reply(user_msg)

        if not is_interaction and interaction_or_message.channel:
            async with interaction_or_message.channel.typing():
                await process_and_reply()
        else:
            await process_and_reply()

    async def announce_event(self, interaction: discord.Interaction, event_name):
        embed = discord.Embed(
            title=event_name,
            description='Please let us know if you can make it!',
            color=0x00AE86
        )
        view = discord.ui.View(timeout=None)
        view.add_item(discord.ui.Button(style=discord.ButtonStyle.success, label='Accept', custom_id='event_accept'))
        view.add_item(discord.ui.Button(style=discord.ButtonStyle.danger, label='Decline', custom_id='event_decline'))

        channel = interaction.channel
        if isinstance(channel, discord.abc.Messageable):
            await channel.send(content='@everyone New Event!', embed=embed, view=view)
        if not interaction.response.is_done():
            await interaction.response.send_message('Event announced!', ephemeral=True)

    async def handle_event_response(self, interaction: discord.Interaction, event_name, response):
        await interaction.response.defer(ephemeral=True)
        try:
            await db.execute(
                'INSERT INTO event_responses (user_id, event_name, response, timestamp) VALUES (%s, %s, %s, %s)',
                (str(interaction.user.id), event_name, response, int(discord.utils.utcnow().timestamp() * 1000))
            )
            await interaction.followup.send(
                f"You have successfully **{response}ed** the event \"{event_name}\". Thank you for letting us know!",
                ephemeral=True
            )
        except Exception as error:
            print(f"Failed to save event response: {error}")
            await interaction.followup.send('There was an error saving your response.', ephemeral=True)

    async def get_sorted_questions(self):
        rows, _ = await db.execute('SELECT * FROM questions ORDER BY order_index ASC')
        return rows

    async def get_user_session(self, user_id):
        rows, _ = await db.execute('SELECT * FROM user_sessions WHERE user_id = %s', (user_id,))
        return rows[0] if rows else None

    async def sync_questions(self, interaction: discord.Interaction):
        webhook_url = os.getenv("WEBHOOK_URL")
        if not webhook_url:
            if interaction.response.is_done():
                await interaction.followup.send("Webhook URL not configured.", ephemeral=True)
            else:
                await interaction.response.send_message("Webhook URL not configured.", ephemeral=True)
            return

        if not interaction.response.is_done():
            await interaction.response.defer(ephemeral=True)

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(webhook_url)
                data = response.json()

            if not isinstance(data, list):
                await interaction.followup.send('Invalid data received from Google Sheets. Is the doGet method configured?', ephemeral=True)
                return

            await db.execute('DELETE FROM questions')

            for q in data:
                choices = q.get('choices')
                if choices is not None:
                    if not isinstance(choices, str):
                        choices = json.dumps(choices)
                else:
                    choices = None
                
                is_required = str(q.get('is_required')).upper() == 'TRUE' or q.get('is_required') == True or q.get('is_required') == 1

                await db.execute("""
                    INSERT INTO questions (question_text, question_type, order_index, is_required, choices)
                    VALUES (%s, %s, %s, %s, %s)
                """, (q.get('question_text', 'Untitled Question'), q.get('question_type', 'text'), int(q.get('order_index', 1)), is_required, choices))

            await interaction.followup.send(f"Successfully synced {len(data)} questions from Google Sheets!", ephemeral=True)
        except Exception as error:
            print(f"Sync error: {error}")
            await interaction.followup.send('Failed to sync questions. Check bot logs.', ephemeral=True)

    async def start_form(self, user, interaction):
        questions = await self.get_sorted_questions()
        if not questions:
            if isinstance(interaction, discord.Interaction):
                if interaction.response.is_done():
                    await interaction.followup.send("No questions configured.", ephemeral=True)
                else:
                    await interaction.response.send_message("No questions configured.", ephemeral=True)
            return

        first_q = questions[0]

        await db.execute("""
            INSERT INTO user_sessions (user_id, current_order_index, is_completed, updated_at)
            VALUES (%s, %s, 0, %s)
            ON DUPLICATE KEY UPDATE
            current_order_index = VALUES(current_order_index),
            is_completed = VALUES(is_completed),
            updated_at = VALUES(updated_at)
        """, (str(user.id), first_q['order_index'], int(discord.utils.utcnow().timestamp() * 1000)))

        await self.send_question(user, interaction, first_q)

    async def send_question(self, user, interaction_or_channel, question):
        embed = discord.Embed(
            title=f"Question {question['order_index']}",
            description=question['question_text'],
            color=0x00AE86
        )

        if question['is_required']:
            embed.set_footer(text="Required")
        else:
            embed.set_footer(text="Optional (Type 'skip' to skip if text)")

        view = discord.ui.View(timeout=None)
        q_type = question['question_type']

        if q_type in ('single_choice', 'yes_no'):
            choices = ['Yes', 'No'] if q_type == 'yes_no' else self._parse_choices(question['choices'])

            if len(choices) > 5:
                select = discord.ui.Select(
                    custom_id='params_select',
                    placeholder='Select an option',
                    options=[discord.SelectOption(label=c[:100], value=str(i)) for i, c in enumerate(choices)]
                )
                view.add_item(select)
            else:
                for i, c in enumerate(choices):
                    btn = discord.ui.Button(
                        style=discord.ButtonStyle.primary,
                        label=c[:80],
                        custom_id=f"choice_{i}"
                    )
                    view.add_item(btn)
                    
        elif q_type == 'multiple_choice':
            choices = self._parse_choices(question['choices'])
            select = discord.ui.Select(
                custom_id='params_multi',
                placeholder='Select one or more options',
                min_values=1,
                max_values=len(choices),
                options=[discord.SelectOption(label=c[:100], value=str(i)) for i, c in enumerate(choices)]
            )
            view.add_item(select)
            
        elif q_type == 'text':
            embed.add_field(name='Instructions', value='Please type your answer in the chat.')

        payload: dict[str, Any] = {'embeds': [embed]}
        if len(view.children) > 0:
            payload['view'] = view

        # Check if target is interaction
        if isinstance(interaction_or_channel, discord.Interaction):
            if interaction_or_channel.response.is_done():
                await interaction_or_channel.followup.send(**payload)
            else:
                await interaction_or_channel.response.send_message(**payload)
        else:
            await interaction_or_channel.send(**payload)

    async def handle_input(self, user, input_val, type):
        session = await self.get_user_session(str(user.id))
        if not session or session['is_completed']:
            return False

        questions = await self.get_sorted_questions()
        current_q = next((q for q in questions if q['order_index'] == session['current_order_index']), None)
        if not current_q:
            return False

        answer_value = None

        if current_q['question_type'] == 'text':
            if type != 'text':
                return "Please type your answer."
            answer_value = input_val
        else:
            if type == 'text':
                return "Please use the buttons or menu to answer."

            choices = ['Yes', 'No'] if current_q['question_type'] == 'yes_no' else self._parse_choices(current_q['choices'])
            indices = input_val if isinstance(input_val, list) else [input_val]

            selected_values = []
            for idx in indices:
                try:
                    selected_values.append(choices[int(idx)])
                except Exception:
                    pass

            if len(selected_values) != len(indices):
                return "Invalid selection."

            if current_q['question_type'] == 'multiple_choice':
                answer_value = json.dumps(selected_values)
            else:
                answer_value = selected_values[0]

        await db.execute(
            'INSERT INTO answers (user_id, question_id, response, timestamp) VALUES (%s, %s, %s, %s)',
            (str(user.id), current_q['id'], answer_value, int(discord.utils.utcnow().timestamp() * 1000))
        )

        curr_idx = next(i for i, q in enumerate(questions) if q['order_index'] == session['current_order_index'])
        next_q = questions[curr_idx + 1] if curr_idx + 1 < len(questions) else None

        if next_q:
            await db.execute(
                'UPDATE user_sessions SET current_order_index = %s, updated_at = %s WHERE user_id = %s',
                (next_q['order_index'], int(discord.utils.utcnow().timestamp() * 1000), str(user.id))
            )
            return {'next': next_q}
        else:
            await db.execute(
                'UPDATE user_sessions SET is_completed = TRUE, updated_at = %s WHERE user_id = %s',
                (int(discord.utils.utcnow().timestamp() * 1000), str(user.id))
            )

            try:
                answers, _ = await db.execute("""
                    SELECT q.question_text, a.response
                    FROM answers a
                    JOIN questions q ON a.question_id = q.id
                    WHERE a.user_id = %s
                    ORDER BY q.order_index ASC
                """, (str(user.id),))

                payload = {
                    'user_id': str(user.id),
                    'username': user.name,
                    'timestamp': discord.utils.utcnow().isoformat(),
                    'answers': {a['question_text']: a['response'] for a in answers}
                }

                webhook_url = os.getenv("WEBHOOK_URL")
                if webhook_url:
                    print(f"Sending data to Webhook for user: {user.name}")
                    async with httpx.AsyncClient() as client:
                        await client.post(webhook_url, json=payload)
                    print('Successfully sent to Webhook')
                else:
                    print('WEBHOOK_URL not set, skipping integration.')
            except Exception as err:
                print(f"Failed to send to Webhook: {err}")

            return {'finished': True}

    async def audit_all_users(self, bot):
        try:
            print("Starting full background audit of all known users...")
            rows, _ = await db.execute('SELECT user_id FROM user_activity')
            for row in rows:
                try:
                    user_id = int(row['user_id'])
                    user = await bot.fetch_user(user_id)
                    if user and not user.bot:
                        await self.handle_user_online(user, force=True)
                except Exception:
                    pass
            print("Full background audit complete.")
        except Exception as e:
            print(f"audit_all_users Error: {e}")

    async def handle_two_way_sync(self, message, missing_column):
        webhook_url = os.getenv("WEBHOOK_URL")
        if not webhook_url:
            print("WEBHOOK_URL is missing! Unable to sync to Google Sheets.")
            return

        try:
            payload = {
                'action': 'update_missing_info',
                'user_id': str(message.author.id),
                'username': message.author.name,
                'column': missing_column,
                'value': message.content,
                'timestamp': discord.utils.utcnow().isoformat()
            }

            async with httpx.AsyncClient() as client_http:
                await client_http.post(webhook_url, json=payload)

            await db.execute(
                'INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (%s, %s, %s, %s)',
                (str(message.author.id), missing_column, message.content, int(discord.utils.utcnow().timestamp() * 1000))
            )

            await self._update_contact_field(message.author, missing_column, message.content)

            print(f"Successfully pushed 2-Way Sync update for {message.author.name}: [{missing_column}] = {message.content}")

            await db.execute("""
                UPDATE pending_updates
                SET status = 'answered'
                WHERE user_id = %s AND missing_column = %s AND status = 'asked'
                LIMIT 1
            """, (str(message.author.id), missing_column))

            await message.reply(f"✅ Got it! Updated your **{missing_column}** successfully.")

            next_pending, _ = await db.execute("""
                SELECT * FROM pending_updates
                WHERE user_id = %s AND status = 'pending'
                ORDER BY id ASC LIMIT 1
            """, (str(message.author.id),))

            if next_pending:
                next_field = next_pending[0]
                await db.execute("UPDATE pending_updates SET status = 'asked' WHERE id = %s", (next_field['id'],))

                real_name = message.author.name
                try:
                    name_rows, _ = await db.execute("""
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = %s AND LOWER(q.question_text) LIKE '%%name%%'
                        LIMIT 1
                    """, (str(message.author.id),))
                    if name_rows:
                        real_name = name_rows[0]['response'].strip()
                except Exception:
                    pass

                remaining, _ = await db.execute(
                    "SELECT COUNT(*) as cnt FROM pending_updates WHERE user_id = %s AND status = 'pending'",
                    (str(message.author.id),)
                )
                left = remaining[0]['cnt'] if remaining else 0

                chain_prompt = f"You are a friendly, casual Discord bot for JerseySTEM. The user \"{real_name}\" just answered a question. They have {left + 1} more fields to fill in their profile. Now ask them for their \"{next_field['missing_column']}\". Write a SHORT (under 30 words), natural follow-up. Do NOT repeat \"Got it\" or \"Thanks\". Just smoothly transition to the next question like a friend texting. Use an emoji."
                intro_text = await self._get_smart_message(chain_prompt, next_field['missing_column'], left)
                await self.send_missing_field_question(message.channel, next_field['missing_column'], intro_text)
                print(f"Chained next question for {message.author.name}: {next_field['missing_column']}")
            else:
                await message.channel.send("🎉 That's everything! Your profile is all filled in now. Thanks for taking the time!")
                print(f"All missing fields complete for {message.author.name}")

        except Exception as e:
            print(f"Failed to two-way sync to Google Sheets: {e}")
            await message.reply("Thanks! (Note: I had trouble reaching the main server to save this instantly, but I've noted it).")

    async def _update_contact_field(self, discord_user, field_label, value):
        try:
            ai_fields, _ = await db.execute('SELECT FIELD_NAME FROM AI_fields WHERE FIELD_LABEL = %s LIMIT 1', (field_label,))
            if not ai_fields:
                return False
            column_name = ai_fields[0]['FIELD_NAME']

            members, _ = await db.execute(
                'SELECT username FROM Members WHERE username = %s OR nickName = %s LIMIT 1',
                (discord_user.name, discord_user.name)
            )
            discord_handle = members[0]['username'] if members else discord_user.name

            query = f"UPDATE Contact SET `{column_name}` = %s WHERE Discord_Handle__c = %s LIMIT 1"
            await db.execute(query, (value, discord_handle))
            print(f"Successfully wrote to Contact table: {discord_handle}'s {column_name} = {value}")
            return True
        except Exception as e:
            print(f"Failed to write directly to Contact table: {e}")
            return False

    async def handle_missing_field_interaction(self, interaction: discord.Interaction, selected_value):
        user_id = interaction.user.id
        await interaction.response.defer()

        pending_rows, _ = await db.execute(
            "SELECT * FROM pending_updates WHERE user_id = %s AND status = 'asked' ORDER BY id ASC LIMIT 1",
            (str(user_id),)
        )

        if not pending_rows:
            await interaction.followup.send("Hmm, I don't have a pending question for you right now.", ephemeral=True)
            return

        missing_column = pending_rows[0]['missing_column']

        try:
            webhook_url = os.getenv("WEBHOOK_URL")
            if webhook_url:
                payload = {
                    'action': 'update_missing_info',
                    'user_id': str(user_id),
                    'username': interaction.user.name,
                    'column': missing_column,
                    'value': selected_value,
                    'timestamp': discord.utils.utcnow().isoformat()
                }
                async with httpx.AsyncClient() as client_http:
                    await client_http.post(webhook_url, json=payload)

            await db.execute(
                'INSERT INTO auto_updates (user_id, column_name, value, timestamp) VALUES (%s, %s, %s, %s)',
                (str(user_id), missing_column, selected_value, int(discord.utils.utcnow().timestamp() * 1000))
            )

            await self._update_contact_field(interaction.user, missing_column, selected_value)

            await db.execute("""
                UPDATE pending_updates
                SET status = 'answered'
                WHERE user_id = %s AND missing_column = %s AND status = 'asked'
                LIMIT 1
            """, (str(user_id), missing_column))

            print(f"Interactive update for {interaction.user.name}: [{missing_column}] = {selected_value}")

            # Edit message to clear buttons/embed
            await interaction.edit_original_response(
                content=f"✅ Got it! Updated your **{missing_column}** to **{selected_value}**.",
                embeds=[],
                view=None
            )

            next_pending, _ = await db.execute("""
                SELECT * FROM pending_updates
                WHERE user_id = %s AND status = 'pending'
                ORDER BY id ASC LIMIT 1
            """, (str(user_id),))

            if next_pending:
                next_field = next_pending[0]
                await db.execute("UPDATE pending_updates SET status = 'asked' WHERE id = %s", (next_field['id'],))

                real_name = interaction.user.name
                try:
                    name_rows, _ = await db.execute("""
                        SELECT a.response FROM answers a
                        JOIN questions q ON a.question_id = q.id
                        WHERE a.user_id = %s AND LOWER(q.question_text) LIKE '%%name%%'
                        LIMIT 1
                    """, (str(user_id),))
                    if name_rows:
                        real_name = name_rows[0]['response'].strip()
                except Exception:
                    pass

                remaining_rows, _ = await db.execute(
                    "SELECT COUNT(*) as cnt FROM pending_updates WHERE user_id = %s AND status = 'pending'",
                    (str(user_id),)
                )
                left = remaining_rows[0]['cnt'] if remaining_rows else 0

                chain_prompt = f"You are a friendly, casual Discord bot for JerseySTEM. The user \"{real_name}\" just selected \"{selected_value}\" for \"{missing_column}\". They have {left + 1} more fields left. Now ask them for their \"{next_field['missing_column']}\". Write a SHORT (under 30 words), natural follow-up. Do NOT repeat \"Got it\" or \"Thanks\". Just smoothly transition to the next question like a friend texting. Use an emoji."
                intro_text = await self._get_smart_message(chain_prompt, next_field['missing_column'], left)
                channel = interaction.channel
                if not isinstance(channel, discord.abc.Messageable):
                    channel = await interaction.user.create_dm()
                await self.send_missing_field_question(channel, next_field['missing_column'], intro_text)
                print(f"Chained next interactive question for {interaction.user.name}: {next_field['missing_column']}")
            else:
                channel = interaction.channel
                if not isinstance(channel, discord.abc.Messageable):
                    channel = await interaction.user.create_dm()
                await channel.send("🎉 That's everything! Your profile is all filled in now. Thanks for taking the time!")
                print(f"All missing fields complete for {interaction.user.name}")

        except Exception as e:
            print(f"Failed interactive two-way sync: {e}")

    async def handle_interaction(self, interaction: discord.Interaction):
        data = interaction.data
        if not isinstance(data, dict):
            return

        custom_id = data.get('custom_id', '')
        if not isinstance(custom_id, str):
            custom_id = ''

        if custom_id.startswith('menu_'):
            await self.handle_main_menu_click(interaction)
            return

        if custom_id.startswith('group_btn_'):
            await self.handle_group_button_click(interaction)
            return

        if custom_id.startswith('missing_btn_'):
            parts = custom_id.split('_')
            selected_value = '_'.join(parts[3:])
            await self.handle_missing_field_interaction(interaction, selected_value)
            return

        if custom_id == 'missing_select':
            values = data.get('values', [])
            if not isinstance(values, list):
                values = []
            if values:
                await self.handle_missing_field_interaction(interaction, values[0])
            return

        if custom_id.startswith('event_'):
            response = 'Accept' if custom_id == 'event_accept' else 'Decline'
            embeds = interaction.message.embeds if interaction.message else []
            event_name = embeds[0].title if embeds else 'Unknown Event'
            await self.handle_event_response(interaction, event_name, response)
            return

        # Onboarding inputs
        answer = None
        if custom_id.startswith('choice_'):
            parts = custom_id.split('_')
            answer = parts[1]
        elif custom_id in ('params_select', 'params_multi'):
            answer = data.get('values')

        if answer is not None:
            await interaction.response.defer()
            result = await self.handle_input(interaction.user, answer, 'interaction')

            if isinstance(result, str):
                await interaction.followup.send(content=result, ephemeral=True)
            elif result and result.get('next'):
                await self.send_question(interaction.user, interaction.channel, result['next'])
            elif result and result.get('finished'):
                channel = interaction.channel
                if not isinstance(channel, discord.abc.Messageable):
                    channel = await interaction.user.create_dm()
                await channel.send(f"Thank you {interaction.user.name}, you have completed the form!")
            return

form_engine = FormEngine()
