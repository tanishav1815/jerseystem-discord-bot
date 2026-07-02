/**
 * permissions.js
 * ──────────────
 * Role-Based Access Control (RBAC) helpers for the JerseySTEM Discord Bot.
 *
 * Role hierarchy:
 *   Admin              → full access, can see all data, use all commands
 *   Program Instructor → can use chatbot + missing info, cannot use admin commands
 *                        or view other members' personal data
 *
 * Role names are configured in .env:
 *   ADMIN_ROLE_NAME=Admin
 *   INSTRUCTOR_ROLE_NAME=Program Instructor
 */

const ADMIN_ROLE = () => process.env.ADMIN_ROLE_NAME || 'Admin';
const INSTRUCTOR_ROLE = () => process.env.INSTRUCTOR_ROLE_NAME || 'Program Instructor';

/**
 * Returns true if the interaction user has the Admin role,
 * is the server owner, OR is listed in ADMIN_USER_IDS in .env.
 */
function isAdmin(interaction) {
    const userId  = interaction.user?.id;
    const ownerId = interaction.guild?.ownerId;

    // 1. Direct user ID allowlist: ADMIN_USER_IDS=id1,id2 in .env
    const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminIds.includes(userId)) return true;

    // 2. Server owner always has admin access
    if (ownerId && ownerId === userId) return true;

    // 3. Discord role name check
    return interaction.member?.roles.cache.some(r => r.name === ADMIN_ROLE()) ?? false;
}

/**
 * Returns true if the interaction user has the Program Instructor role.
 */
function isInstructor(interaction) {
    return interaction.member?.roles.cache.some(r => r.name === INSTRUCTOR_ROLE()) ?? false;
}

/**
 * Returns true if the user has ANY recognized role (Admin OR Instructor).
 */
function hasAnyRole(interaction) {
    return isAdmin(interaction) || isInstructor(interaction);
}

/**
 * Returns true if the user is allowed to view another member's personal data.
 * Only Admins can look up OTHER people's data.
 * Instructors can only see their own.
 *
 * @param {Interaction} interaction
 * @param {string|null} targetUsername - The username being queried (null = querying self)
 */
function canViewMemberData(interaction, targetUsername = null) {
    // Everyone can view their own data
    if (!targetUsername || targetUsername === interaction.user.username) return true;
    // Only admins can view others' data
    return isAdmin(interaction);
}

/**
 * Sends a standard ephemeral "no permission" reply.
 * Use this as the rejection response in all restricted commands.
 *
 * @param {Interaction} interaction
 * @param {string} [reason] - Optional custom message
 */
async function denyAccess(interaction, reason = null) {
    const msg = reason
        ? `❌ **Access Denied:** ${reason}`
        : `❌ **Access Denied:** You need the **${ADMIN_ROLE()}** role to use this command.`;

    if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: msg, ephemeral: true });
    } else {
        await interaction.reply({ content: msg, ephemeral: true });
    }
}

module.exports = { isAdmin, isInstructor, hasAnyRole, canViewMemberData, denyAccess };
