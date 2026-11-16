# Acme Desktop

Acme is a team chat app. The desktop app has one window. The **sidebar** on
the left lists the inbox, the channels, and the people. The rest of the window
shows the room that is open: a channel or a direct message. **Settings** opens
as a pane.

The app also has a small second window, the **mini player** (its URL ends in
`/mini`). It shows only while the main window is hidden, so it is empty while
the main window is open. Do not switch to it, and do not report it as blank.

## Sign in

You start signed in. Bugpatrol gave the app a test session before it started.

- If you see the sign-in screen (`sign-in-screen`) with an email field, sign in
  failed. Report it as a critical bug, then finish.

## Onboarding

A new test user sees two onboarding screens first. Complete them:

1. "Tell us who you are": type `Bugpatrol` as the first name and `Patrol` as the
   last name. If the screen asks for a username, type `bugpatrol{{UNIQUE}}`:
   each patrol has a new test user, and a username must be unique. Then
   click Continue.
2. "Name your workspace": type `Bugpatrol Patrol` as the workspace name. Keep the
   URL that the app suggests. Then click the submit button.

You are in the app when you see the sidebar and a channel with a message box.
Save the path through onboarding as the routine `enter-app`.

## What to explore

- Each sidebar row: the inbox, each channel, and people.
- Settings and each of its sections.
- The "New channel" flow. You may make channels whose names start with
  `bugpatrol-`.
- In a channel that you made, you may send one short message, such as
  `Bugpatrol test message`. Look at how the message renders.
- Menus, tabs, dialogs, and empty states.

## Never do these things

- Do not sign out.
- Do not delete the workspace or the account.
- Do not start or join a call.
- Do not buy, upgrade, or open a billing checkout.
- Do not invite a person by email.
- Do not change the theme, the language, or any setting that stays after a
  restart, except in a channel that you made.
