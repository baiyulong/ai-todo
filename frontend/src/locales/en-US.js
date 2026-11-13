/* AI Todo · English language pack */

export const dict = {
  // ---------------- Common ----------------
  'app.name': 'AI Todo',

  // ---------------- Sign in ----------------
  'login.title': 'Sign in to AI Todo',
  'login.hint': 'Sign in with your account. The initial admin password is in',
  'login.hintFile': 'data/admin-credentials.txt',
  'login.username': 'Username',
  'login.usernamePlaceholder': 'Your username',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Enter your password',
  'login.submit': 'Sign in',
  'login.showPassword': 'Show password',
  'login.hidePassword': 'Hide password',
  'login.invalidCredentials': 'Incorrect username or password',

  // ---------------- WeChat scan-to-sign-in ----------------
  'login.or': 'or',
  'login.wechatLogin': 'Sign in with WeChat',
  'login.wechatScanTip': 'Scan the QR code with WeChat',
  'login.wechatCancel': 'Cancel',
  'login.wechatExpired': 'QR code expired — please scan again',
  'login.wechatFailed': 'WeChat sign-in failed, please try again',
  'login.wechatOpenLink': 'Open the authorization page in a browser',
  'login.wechatQrFailed': 'Could not render the QR code — use the link below instead',

  // ---------------- Top bar ----------------
  'topbar.liveStatus': 'Live connection status',
  'topbar.connecting': 'Connecting',
  'topbar.live': 'Live',
  'topbar.reconnecting': 'Reconnecting',
  'topbar.offline': 'Signed out',
  'topbar.currentAccount': 'Current account',
  'topbar.tokens': 'Tokens',
  'topbar.users': 'Users',
  'topbar.logout': 'Sign out',
  'section.rules': 'Notification rules',
  'topbar.settings': 'Settings',
  'topbar.language': 'Switch language',
  'topbar.languageName': 'English',
  'topbar.help': 'User guide',

  // ---------------- Notification permission banner ----------------
  'banner.enable': 'Turn on desktop notifications so AI can pop a banner the moment it finishes a task.',
  'banner.enableBtn': 'Turn on',
  'banner.unsupported': 'This browser does not support system notifications. In-page hints will be used instead.',
  'banner.denied': 'Notification permission was denied. Allow notifications in the site settings to the left of the address bar, then reload.',
  'banner.insecure': 'You are visiting over HTTP, so the browser has disabled web notifications. Open http://localhost:8787 on this machine to enable them; other LAN devices need HTTPS. In-page alerts and sounds still work.',
  'banner.close': 'Close',

  // ---------------- Toolbar ----------------
  'tab.pending': 'Pending',
  'tab.acked': 'In progress',
  'tab.done': 'Done',
  'tab.all': 'All',
  'toolbar.clearArchived': 'Clear archived',
  'toolbar.clearArchivedCount': 'Clear archived ({count})',
  'toolbar.allSeverities': 'All levels',
  'toolbar.filterSeverity': 'Filter by level',
  'toolbar.allSources': 'All sources',
  'toolbar.filterSource': 'Filter by source',
  'toolbar.allProjects': 'All projects',
  'toolbar.filterProject': 'Filter by project',
  'toolbar.searchPlaceholder': 'Search…',
  'toolbar.searchLabel': 'Search tasks',

  // ---------------- Severity / status ----------------
  'severity.info': 'Note',
  'severity.need_human': 'Needs you',
  'severity.blocker': 'Blocking',
  'status.pending': 'Pending',
  'status.acked': 'In progress',
  'status.done': 'Done',
  'status.archived': 'Archived',

  // ---------------- Empty state ----------------
  'empty.title': 'All quiet here',
  'empty.sub': 'When AI finishes a task it pushes it here over MCP, so nothing slips by.',

  // ---------------- Task card ----------------
  'task.addTitle': 'Add a task manually',
  'task.remindAt': 'Remind {time}',
  'task.sourceTitle': 'Source: {agent} (session {session}) · click to filter by this source',
  'task.projectTitle': 'Source project: {project}',
  'task.deleteTitle': 'Archive (recoverable from the “All” tab)',
  'task.hardDeleteTitle': 'Delete permanently (cannot be undone)',
  'task.deleteLabel': 'Archive task',
  'task.hardDeleteLabel': 'Delete task permanently',
  'task.deletedToast': 'Archived — find it again under the “All” tab',

  // ---------------- Task transfer ----------------
  'task.transfer': 'Hand off',
  'task.transferLabel': 'Pick a person to hand off to',
  'task.transferPlaceholder': 'Hand off to…',
  'task.transferPick': 'Pick a person first',
  'task.transferredToast': 'Handed off to {user} — they have been notified',
  'task.transferDisabledHint': 'You are the only user — nobody to hand off to',
  'task.replyLabel': 'Your reply',
  'task.replyCopy': 'Copy reply',
  'task.replyPlaceholder': 'Reply to this task — it is marked done and the waiting AI receives it right away',
  'task.reply': 'Reply',
  'task.repliedToast': 'Replied — the AI will receive your answer',

  // ---------------- Actions ----------------
  'action.ack': 'Take',
  'action.done': 'Done',
  'action.snooze': 'Snooze',
  'action.snooze1h': 'In 1 hour',
  'action.snoozeTonight': 'Tonight 20:00',
  'action.snoozeMorning': 'Tomorrow 09:00',
  'action.snoozedToast': 'Snoozed until {time}',

  // ---------------- Confirm dialog ----------------
  'confirm.title': 'Confirm',
  'confirm.ok': 'Confirm',
  'confirm.cancel': 'Cancel',
  'confirm.hardDeleteTitle': 'Delete this task permanently?',
  'confirm.hardDeleteText': 'This cannot be undone. The task and its notification records are removed for good.',
  'confirm.hardDeleteOk': 'Delete permanently',
  'confirm.hardDeletedToast': 'Deleted permanently',
  'confirm.purgeTitle': 'Clear {count} archived tasks?',
  'confirm.purgeText': 'These tasks will be deleted for good and cannot be recovered. Pending, in-progress and done tasks are not affected.',
  'confirm.purgeOk': 'Delete all',
  'confirm.purgedToast': 'Cleared {count} archived tasks',

  // ---------------- Manual add ----------------
  'taskDialog.title': 'Add a task manually',
  'taskDialog.fieldTitle': 'Title',
  'taskDialog.titlePlaceholder': 'What needs doing?',
  'taskDialog.fieldDetail': 'Details (optional)',
  'taskDialog.detailPlaceholder': 'Add any context',
  'taskDialog.fieldSeverity': 'Level',
  'taskDialog.fieldProject': 'Project',
  'taskDialog.notify': 'Notify me right away',
  'taskDialog.cancel': 'Cancel',
  'taskDialog.submit': 'Add',
  'taskDialog.addedToast': 'Added',

  // ---------------- Drawer: settings ----------------
  'drawer.settings': 'Settings',
  'drawer.close': 'Close',
  'section.status': 'Status',
  'section.mcp': 'MCP setup',
  'section.shortcuts': 'Keyboard shortcuts',
  'section.language': 'Language',
  'section.theme': 'Theme',
  'theme.product': 'Product · Apple',
  'theme.productDesc': 'Frosted glass, iOS system colors, clean default UI',
  'theme.pixel': 'Pixel · Paper',
  'theme.pixelDesc': 'pi.dev-style terminal paper: serif prose, mono UI, graph-paper grid',
  'theme.hacker': 'Hacker',
  'theme.hackerDesc': 'Pure black terminal, phosphor green, CRT scanlines',
  'section.appearance': 'General',
  'section.wechat': 'WeChat account',

  // ---------------- Dedicated management pages ----------------
  'page.back': 'Back to tasks',
  'page.usersTitle': 'User management',
  'page.tokensTitle': 'Token management',

  'status.notifyPermission': 'Desktop notifications',
  'status.liveConnection': 'Live connection',
  'status.pendingTasks': 'Pending tasks',
  'status.roleAdmin': 'Administrator',
  'status.roleUser': 'Standard user',
  'status.wechatBound': 'WeChat linked',
  'status.wechatYes': 'Linked',
  'status.wechatNo': 'Not linked',

  // ---------------- WeChat account linking ----------------
  'wechat.bind': 'Link WeChat',
  'wechat.rebind': 'Link a different WeChat',
  'wechat.bindTitle': 'Link WeChat',
  'wechat.bindHint':
    'Scan the QR code with WeChat to link it to this account. Once linked you can sign in by scanning, without typing a username and password.',
  'wechat.scanTip': 'Scan the QR code with WeChat',
  'wechat.bindDone': 'WeChat linked',
  'wechat.tokenTitle': 'Here is your MCP access token',
  'wechat.tokenHint': 'Shown only once — copy and save it now.',
  'wechat.tokenCopy': 'Copy',
  'wechat.tokenCopied': 'Copied',
  'wechat.tokenCopyFailed': 'Copy failed — please select and copy it manually',

  'perm.granted': 'Allowed',
  'perm.denied': 'Denied',
  'perm.insecure': 'Unavailable (HTTP)',
  'perm.default': 'Not set',
  'perm.unsupported': 'Unsupported',

  // ---------------- Email binding ----------------
  'email.section': 'Email',
  'email.current': 'Bound email',
  'email.boundHint': 'Task notifications and hand-offs are sent to this address.',
  'email.needBind': 'No email bound yet. Once bound, new tasks and hand-offs will reach you by email.',
  'email.placeholder': 'Email address',
  'email.codePlaceholder': '6-digit code',
  'email.sendCode': 'Send code',
  'email.bind': 'Confirm',
  'email.codeSent': 'Code sent — check your inbox (valid for 15 minutes)',
  'email.needEmail': 'Please enter an email address',
  'email.needCode': 'Please enter the code',
  'email.boundToast': 'Email bound',
  'email.change': 'Change email',
  'email.bannerText': 'No email bound — task and hand-off email notifications cannot reach you.',
  'email.bannerBtn': 'Bind now',

  // ---------------- Change password ----------------
  'password.change': 'Change password',
  'password.set': 'Set a password',
  'password.old': 'Current password',
  'password.new': 'New password',
  'password.confirm': 'Confirm new password',
  'password.newPlaceholder': 'At least 8 characters',
  'password.save': 'Save new password',
  'password.changedToast': 'Password updated',
  'password.mismatch': 'The two new passwords do not match',

  // ---------------- Access tokens ----------------
  'token.hint': 'To push tasks over MCP, your AI client needs an access token of your own. The credential must live in the client’s AI_TODO_TOKEN environment variable — you can copy any token from the list below at any time. A token is bound to a project when issued; every task it pushes lands in that project.',
  'token.loadFailed': 'Could not load tokens: {message}',
  'token.empty': 'No tokens issued yet.',
  'token.lastUsed': 'Last used {time}',
  'token.neverUsed': 'Never used',
  'token.revoked': 'Revoked',
  'token.valid': 'Valid',
  'token.delete': 'Delete',
  'token.deletedToast': 'Token deleted',
  'token.namePlaceholder': 'Token name, e.g. claude-code',
  'token.fieldProject': 'Bound project (pushed tasks land here)',
  'token.issue': 'Issue new token',
  'token.issuedToast': 'Token issued — copy it now',
  'token.copy': 'Copy',
  'token.copiedToast': 'Copied',
  'token.copyFailedToast': 'Copy failed — select it and copy manually',

  // ---------------- Projects ----------------
  'topbar.projects': 'Projects',
  'page.projectsTitle': 'Projects',
  'project.hint': 'Every task belongs to a project: create projects first, bind one when issuing a token, and tasks pushed by that token land in it automatically. Each account has a default project that cannot be deleted.',
  'project.empty': 'No projects yet.',
  'project.namePlaceholder': 'Project name',
  'project.create': 'Create project',
  'project.defaultBadge': 'Default',
  'project.taskCount': '{count} tasks',
  'project.delete': 'Delete',
  'project.deleteTitle': 'Delete project “{name}”?',
  'project.deleteText': 'Its {count} tasks and any tokens bound to it will move to the default project.',
  'project.createdToast': 'Project created',
  'project.deletedToast': 'Project deleted',

  // ---------------- Theme FX ----------------


  // ---------------- MCP ----------------
  'mcp.hint': 'Paste this into your AI client’s MCP configuration (MCode / Claude Code / Cursor / Trae) and the AI can push finished tasks to you.',
  'mcp.tokenPlaceholder': '<issue a token under “Tokens” and paste it here>',
  'mcp.isolation': 'Each user only sees their own tasks — the token decides who a task lands for.',
  'mcp.httpTitle': 'Remote HTTP (recommended — nothing to install on the client)',
  'mcp.httpHint': 'Pick the “HTTP” transport in your AI client, then paste this URL and header.',
  'mcp.copy': 'Copy',
  'mcp.copied': 'Copied',
  'mcp.copyFailed': 'Copy failed — select it and copy manually',
  'mcp.copyNeedToken': 'Copied, but the token is still a placeholder — issue a real token and replace it first',
  'mcp.sourceHint': 'To label tasks with “which tool, which project”: add the X-Ai-Todo-Agent and X-Ai-Todo-Project headers.',

  // ---------------- User management ----------------
  'user.hint': 'Creating an account generates an initial password and issues an access token automatically — both are shown only once, at creation time.',
  'user.loadFailed': 'Could not load users: {message}',
  'user.newTitle': 'Create an account',
  'user.listTitle': 'Accounts',
  'user.colUsername': 'Username',
  'user.colRole': 'Role',
  'user.colStatus': 'Status',
  'user.colActions': 'Actions',
  'user.self': '(you)',
  'user.reset': 'Reset password',
  'user.resetTitle': 'Generate a random new password and email it to {email}',
  'user.resetNoEmailHint': 'No email bound — the new password will be shown once here only; deliver it offline',
  'user.resetConfirm': 'Reset the password for {username}? All their sessions will be signed out.',
  'user.resetSentToast': 'New password sent to {email}',
  'user.resetFallbackToast': 'Email unavailable (no address bound or SMTP not configured) — the new password is shown below once',
  'user.resetFor': 'Password reset for {username} — shown only once',
  'user.delete': 'Delete',
  'user.deleteTitle': 'Permanently remove this account and all its tasks, notifications, tokens and sessions',
  'user.deleteConfirm': 'Delete account {username}?\n\nAll of their tasks, notifications, tokens and sessions will be permanently removed. This cannot be undone.',
  'user.deletedToast': 'Account {username} deleted',
  'error.last_admin': 'You cannot delete the last administrator account',
  'user.empty': 'No other accounts yet.',
  'user.createdFor': 'Initial credentials for {username}',
  'user.createdPassword': 'Initial password (shown only once)',
  'user.createdTokenLabel': 'MCP access token (shown only once)',
  'user.credentialDismiss': 'Saved — hide this',
  'user.noUsername': '(no username)',
  'user.flagAdmin': 'Administrator',
  'user.flagWechat': 'WeChat sign-in',
  'user.flagNormal': 'Active',
  'user.newUsernamePlaceholder': 'New username (3–32 chars: lowercase letters, digits, . _ -)',
  'user.newEmailPlaceholder': 'Email (required, receives task notifications)',
  'user.needEmail': 'Please enter an email address',
  'user.noEmail': 'No email bound',
  'user.create': 'Create account',
  'user.needUsername': 'Please enter a username',
  'user.createdToast': 'Account created: {username} — the initial password is shown only once',

  // ---------------- Notification rules ----------------
  'rules.loading': 'Loading rules…',
  'rules.minSeverity': 'Minimum alert level',
  'rules.minSeverityHint': 'Tasks below this level are stored but never interrupt you.',
  'rules.minSeverityInfo': 'All notes',
  'rules.minSeverityNeedHuman': 'Needs-you and up',
  'rules.minSeverityBlocker': 'Blocking only',
  'rules.cooldown': 'Cooldown (seconds)',
  'rules.cooldownHint': 'Several tasks from the same source within this window are merged into one notification. 0 disables merging.',
  'rules.groupBy': 'Merge by',
  'rules.groupByHint': 'Decides which tasks get merged together.',
  'rules.groupBySession': 'AI session',
  'rules.groupByProject': 'Project',
  'rules.groupByNone': 'Never merge',
  'rules.quietHours': 'Quiet hours',
  'rules.quietHoursHint': 'Leave empty to disable. Crosses midnight like 23:00 → 08:00.',
  'rules.digestHour': 'Daily digest at',
  'rules.digestHourHint': 'Leave empty to disable. Acts as a safety net so nothing important slips by.',
  'rules.save': 'Save rules',
  'rules.quietHoursFormat': 'Quiet hours must look like HH:MM - HH:MM',
  'rules.savedToast': 'Rules saved',

  // ---------------- Shortcuts ----------------
  'shortcut.move': 'Move up / down',
  'shortcut.ack': 'Take over',
  'shortcut.done': 'Mark done',
  'shortcut.search': 'Focus search',

  // ---------------- Notification permission ----------------
  'notify.enabledToast': 'Desktop notifications are on',
  'notify.testTitle': 'AI Todo notifications are on',
  'notify.testBody': 'This is how AI will ping you when it finishes something.',

  // ---------------- Server errors (translated by code) ----------------
  'error.unauthorized': 'Your session expired — please sign in again',
  'error.invalid_credentials': 'Incorrect username or password',
  'error.wrong_password': 'Current password is incorrect',
  'error.email_not_configured': 'SMTP is not configured on the server — verification email cannot be sent',
  'error.email_already_bound': 'This email is already bound to another account',
  'error.email_code_invalid': 'Invalid or expired code',
  'error.invalid_argument': 'Invalid argument',
  'error.invalid_argument.enum': 'Invalid value for {param}: {value}. Allowed: {allowed}',
  'error.invalid_argument.uuid': 'Path parameter {param} is not a valid UUID: {value}',
  'error.forbidden': 'Not allowed',
  'error.not_found': 'Not found',
  'error.task_not_found': 'Task not found',
  'error.task_not_archived': 'Archive the task first — only archived tasks can be deleted permanently',
  'error.token_not_found': 'Token not found',
  'error.project_not_found': 'Project not found',
  'error.project_name_taken': 'A project with this name already exists',
  'error.project_default_undeletable': 'The default project cannot be deleted',
  'error.project_name_invalid': 'Project name must be 1-120 characters',
  'error.user_not_found': 'User not found',

  // ---------------- WeChat sign-in ----------------
  'error.wechat_not_configured': 'WeChat sign-in is not configured on the server',
  'error.wechat_state_invalid': 'This sign-in request expired — please start over',
  'error.wechat_state_expired': 'QR code expired — please scan again',
  'error.wechat_code_invalid': 'Invalid or reused WeChat code — please scan again',
  'error.wechat_api_error': 'WeChat API request failed — please try again later',
  'error.wechat_already_bound': 'This WeChat account is already linked to another account',
  'error.wechat_account_disabled': 'This account has been disabled',
  'error.wechat_login_failed': 'WeChat sign-in failed, please try again',

  // ---------------- Help document (Markdown, opened from the "?" icon) ----------------
  'help.title': 'User Guide',
  'help.close': 'Close',
  'help.doc': `## Getting started
- Sign in to see your task list; the number in the top bar is your pending count
- Status flow: **Pending → Acknowledged → Done → Archived**
- Shortcuts: j/k select, a acknowledge, d done, / focus search, Esc back to list

## Push tasks with AI (MCP)
Add one of the following to your AI client's MCP settings:

### Option 1: remote HTTP (recommended, nothing to install)
\`\`\`json
{
  "mcpServers": {
    "ai-todo": {
      "url": "https://<your-server>/mcp",
      "headers": { "Authorization": "Bearer <access-token>" }
    }
  }
}
\`\`\`

### Option 2: local stdio (client on the same machine as the service)
\`\`\`json
{
  "mcpServers": {
    "ai-todo": {
      "command": "node",
      "args": ["<app-dir>/dist/src/cli.js", "mcp"],
      "env": {
        "AI_TODO_BASE_URL": "<server-url>",
        "AI_TODO_TOKEN": "<access-token>"
      }
    }
  }
}
\`\`\`

- Access token: top-right avatar → **Tokens** page, self-service
- Tools: todo_create to add / todo_list to query / todo_update to append progress
- Severities: **Blocker** (red), **Needs human** (yellow), **Notice** (blue)
- AI updates only append progress notes and never change the status; the status is yours to advance

## Notifications
- In-page banners, sounds and desktop notifications (adjustable in Settings)
- Email: once the admin configures SMTP, tasks are mailed to the address bound to your account
- WeChat sign-in: bind once, then just scan to sign in; accounts are created on first scan

## Top-bar status dot
- **Live**: SSE push is working; tasks refresh instantly
- **Connecting / Signed out**: the realtime stream is unavailable (often a corporate gateway); the app falls back to 30s polling so data still updates

## FAQ
- MCP error "unable to get local issuer certificate": the corporate certificate is not trusted by Node. Set NODE_EXTRA_CA_CERTS=<corp-ca.pem> on the client machine and restart (for quick debugging only, NODE_TLS_REJECT_UNAUTHORIZED=0 also works)
- No email arriving: check spam first; confirm the account has an email bound; then ask the admin to verify the SMTP settings
- Projects and tokens: top-right avatar menu; user management is admin-only`,
};
