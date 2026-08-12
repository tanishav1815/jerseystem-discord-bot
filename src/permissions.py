import os
import discord

def get_admin_role_name():
    return os.getenv('ADMIN_ROLE_NAME', 'Admin')

def get_instructor_role_name():
    return os.getenv('INSTRUCTOR_ROLE_NAME', 'Program Instructor')

def get_validated_visitor_role_name():
    return os.getenv('VALIDATED_VISITOR_ROLE_NAME', 'Validated Visitor')

def is_validated_visitor(member: discord.Member | discord.User) -> bool:
    if isinstance(member, discord.Member):
        return any(r.name == get_validated_visitor_role_name() for r in member.roles)
    return False

def is_admin(interaction: discord.Interaction) -> bool:
    user_id = str(interaction.user.id)
    guild = interaction.guild
    owner_id = str(guild.owner_id) if guild else None

    # 1. Direct user ID allowlist
    admin_ids = [s.strip() for s in os.getenv('ADMIN_USER_IDS', '').split(',') if s.strip()]
    if user_id in admin_ids:
        return True

    # 2. Server owner always has admin access
    if owner_id and owner_id == user_id:
        return True

    # 3. Discord role name check
    if isinstance(interaction.user, discord.Member):
        return any(r.name == get_admin_role_name() for r in interaction.user.roles)
    
    return False

def is_instructor(interaction: discord.Interaction) -> bool:
    if isinstance(interaction.user, discord.Member):
        return any(r.name == get_instructor_role_name() for r in interaction.user.roles)
    return False

def has_any_role(interaction: discord.Interaction) -> bool:
    return is_admin(interaction) or is_instructor(interaction)

def can_view_member_data(interaction: discord.Interaction, target_username: str | None = None) -> bool:
    # Everyone can view their own data
    if not target_username or target_username == interaction.user.name:
        return True
    # Only admins can view others' data
    return is_admin(interaction)

async def deny_access(interaction: discord.Interaction, reason: str | None = None):
    msg = (
        f"❌ **Access Denied:** {reason}"
        if reason
        else f"❌ **Access Denied:** You need the **{get_admin_role_name()}** role to use this command."
    )

    if interaction.response.is_done():
        await interaction.followup.send(msg, ephemeral=True)
    else:
        await interaction.response.send_message(msg, ephemeral=True)
