# M-A Building Field Timesheets

A phone-friendly web app where field employees log weekly hours by jobsite, foremen enter hours for their crews, and supervisors approve and export them for payroll.

- **Website hosting:** GitHub Pages (free)
- **Logins and data:** Supabase (free tier)
- **Setup time:** about 30–45 minutes, one time. No coding needed.

---

## What each role can do

| | Employee | Foreman | Supervisor |
|---|:-:|:-:|:-:|
| Enter and edit their own hours | ✅ | ✅ | ✅ |
| Enter hours for crew on **their assigned jobsites** | | ✅ | ✅ (any jobsite) |
| See crew hours on their jobsites | | ✅ | ✅ |
| Approve hours, or send them back for correction | | | ✅ |
| Export to Excel/CSV for payroll | | | ✅ |
| Add jobsites and assign foremen | | | ✅ |
| Set people's names and roles, deactivate people | | | ✅ |

**Other rules:**

- Approved hours are locked. Nobody but a supervisor can change them.
- Hours that are sent back show in red for the employee or foreman to fix and resave.
- Every entry records who entered it, so you can tell when a foreman entered hours for someone.
- These rules are enforced by the database itself, not just the screens.

---

## Part 1: Set up Supabase (logins and database)

1. Go to **https://supabase.com** and sign up. Signing in with your GitHub account is easiest, so you may want to do Part 3, step 1 first.
2. Click **New project**.
   - **Name:** `ma-timesheets`
   - **Database password:** click *Generate*, then save it somewhere safe.
   - **Region:** East US
   - Click **Create new project** and wait about 2 minutes.
3. **Create the database tables.** In the left menu, open **SQL Editor** and click **New query**.
   - Open the file `supabase/schema.sql` from this folder (Notepad works), copy all of it, and paste it in.
   - Click **Run**. You should see "Success. No rows returned."
4. **Lock down sign-ups**, so only people you add can log in.
   - Go to **Authentication → Sign In / Providers**.
   - Turn **off** *Allow new users to sign up*.
   - Leave the **Email** provider turned on. Click **Save**.
5. **Create your own login.**
   - Go to **Authentication → Users → Add user → Create new user**.
   - Enter your email and a password, tick **Auto Confirm User**, and click **Create user**.
6. **Make yourself a supervisor.** Back in **SQL Editor → New query**, paste the following, change the email and name to yours, and click **Run**:

   ```sql
   update public.profiles set role = 'supervisor', full_name = 'Joe Thomas'
   where email = 'jthomas@mabldg.com';
   ```

7. **Copy your two connection values.** Click **Connect** at the top of the project, or go to **Project Settings → API Keys**. Copy:
   - the **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - the **publishable key** (starts with `sb_publishable_…`), or the **anon public** key on the *Legacy API keys* tab. Either one works.

   > ⚠️ Never use the **secret** or **service_role** key here.

## Part 2: Put your values in the app

Open `js/config.js` in Notepad and fill in the two lines:

```js
SUPABASE_URL: 'https://abcdefgh.supabase.co',
SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxxxxxx',
```

In the same file you can also change:

- **`WEEK_START_DAY`:** the first day of your pay week. `1` = Monday (the default), `0` = Sunday.
- **`OVERTIME_THRESHOLD`:** the weekly hours after which time counts as overtime. Default is `40`.
- **`COST_CODES`:** an optional list of cost codes that show up as suggestions when entering hours.

Save the file.

## Part 3: Publish the website on GitHub Pages

1. Go to **https://github.com** and sign up (free).
2. Click **+ → New repository**.
   - **Name:** `timesheets`
   - Set it to **Public**. GitHub Pages is free for public repositories.
   - Click **Create repository**.

   > Only the app's code is public. Your employees' hours and logins live in Supabase behind the login and are **not** in GitHub.

3. On the new repository page, click **uploading an existing file**.
   - Drag in **everything inside** the `timesheet-app` folder: `index.html`, `manifest.json`, and the folders `css`, `js`, `icons` and `supabase`.
   - `index.html` must be at the top level, not inside another folder.
   - Click **Commit changes**.
4. Go to **Settings → Pages**.
   - Under *Build and deployment*, set **Source** to **Deploy from a branch**.
   - Set **Branch** to `main` and the folder to `/ (root)`. Click **Save**.
5. Wait 1–2 minutes and refresh the page. Your site address appears at the top, for example **`https://YOUR-USERNAME.github.io/timesheets/`**.
6. Back in Supabase, go to **Authentication → URL Configuration**.
   - Set **Site URL** to that address.
   - Add the same address under **Redirect URLs**.
   - Save. This makes "Forgot password" emails link back to your app.

Open the address and sign in. You should see five tabs: My Hours, Crew Hours, Review & Export, Jobsites and People.

## Part 4: Add jobsites and people

1. **Jobsites tab:** add each active job with its job number and name.
2. **People tab → + Add person.** This button needs Part 7 done first, which is a one-time, 5-minute step.
   - Enter the person's name and email/login, and pick their role.
   - A temporary password is filled in for you.
   - Click **Create login**. The app shows the login details to text or hand to the person, with a **Copy** button.
   - **No company email?** Make one up in a consistent format, such as `jsmith@mabldg-crew.com`. It only has to look like an email. Those people can't use "Forgot password", so you use **Reset password** on the People tab instead.
3. **Jobsites tab:** tick the foremen who run each jobsite and click **Save**. A foreman can enter crew hours only on jobsites they are ticked on.

> If you'd rather skip Part 7, you can still add people in Supabase: go to **Authentication → Users → Add user**, and tick **Auto Confirm User**. They then appear on the People tab as an Employee, where you set their name and role.

## Part 5: Put it on employees' phones

Send everyone the website address. To make it look like an app on their phone:

- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

---

## Weekly routine

**Employees, on My Hours:**

1. Pick the jobsite.
2. Type hours under each day.
3. Tap **Save hours**.

Under each day's hours, tick **Swing-Pay** and/or **Gas** if they apply that day. A box can only be ticked on a day that has hours.

To log time on two jobsites in one day, use **+ Add jobsite**. **Copy last week's jobsites** pre-fills the rows.

**Foremen, on Crew Hours:**

1. Choose the jobsite.
2. Tap **Add last week's crew**, or add people one at a time.
3. Enter the first person's hours and Swing-Pay/Gas boxes, then tap **Copy row 1 to empty rows** to fill the rest of the crew. Adjust anyone who differs.
4. Tap **Save crew hours**.

**Supervisors, on Review & Export:**

1. Check the yellow box, which lists who hasn't entered any hours yet.
2. Click **Select all waiting**, then **Approve selected**. Use **Send back selected** for anything that needs fixing.
3. Download the payroll file:
   - **Export payroll summary** gives one line per employee, jobsite and cost code, with each day's hours, the weekly total, and regular and overtime split at 40 hours. It also shows the number of Swing-Pay and Gas days per line and per employee for the week. A day counts once even if the person worked two jobsites that day.
   - **Export detail** gives one line per entry, with Yes in the Swing-Pay and Gas columns for the days they apply.

---

## Part 6: Common admin tasks

**Someone leaves.** On the People tab, untick **Active** and click Save. Their past hours are kept, and they can no longer log in. Don't delete them in Supabase: the database blocks deleting anyone who has hours on record, to protect payroll history.

**Reset someone's password.** Go to the **People** tab, click **Reset password** on their row, and give them the new password shown. This needs Part 7.

Without Part 7, you can do it in Supabase instead: go to **SQL Editor**, change the email and the new password below, and click **Run**:

```sql
update auth.users
set encrypted_password = extensions.crypt('NewPassword123', extensions.gen_salt('bf'))
where email = 'jsmith@mabldg-crew.com';
```

**Anyone can change their own password** with the **Password** button at the top of the app.

**Change a setting later**, such as the week start or cost codes:

1. On GitHub, open `js/config.js`.
2. Click the ✏️ pencil icon, edit the setting, and click **Commit changes**.
3. The site updates within a minute or two.

---

## Part 7: Let supervisors add people and reset passwords in the app (one time)

Creating logins needs Supabase's secret admin key. That key must never go in the website, where anyone could read it. Instead, it lives in a small server-side function inside Supabase that only does what signed-in supervisors ask.

1. In Supabase, open **Edge Functions** in the left menu.
2. Click **Deploy a new function**, then **Via Editor**.
3. Name it exactly **`manage-users`**.
4. Delete the sample code in the editor.
   - Open `supabase/functions/manage-users/index.ts` from this folder (Notepad works), copy all of it, and paste it in.
   - Click **Deploy function** and wait for "Deployed".
5. Turn off the extra key check. Open the function's **Details** (or **Settings**) page.
   - Turn **off** **Verify JWT with legacy secret** (it may be labeled *Enforce JWT Verification*). Click **Save**.
   - This is safe: the function checks for itself that the request comes from an active supervisor, and refuses everyone else.
6. Test it. In the app, go to **People → + Add person** and create a test login. If it complains that user management isn't set up, recheck the function name in step 3. If it says the request was rejected, recheck step 5.

You don't need to copy any keys. Supabase gives the function its admin key automatically.

---

## Costs and limits

- **GitHub Pages:** free.
- **Supabase free tier:** this covers 25 users easily.
  - Free projects pause after about a week with **no activity at all**. Regular weekly use keeps the project awake.
  - If it ever pauses, for example over a long holiday, click **Restore** in the Supabase dashboard.
  - The **Pro plan (about $25/month)** never pauses and adds daily backups. It's worth it once payroll depends on the app.
- **Internet:** the app needs a connection to save. In areas with poor signal, enter hours and tap Save once you have service.

## Files

```
index.html          the app page
css/styles.css      look and layout
js/config.js        ← your settings (Supabase URL/key, week start, OT, cost codes)
js/app.js           app logic
manifest.json       lets phones "install" it to the home screen
icons/              app icons
supabase/schema.sql database tables and security rules (run once in Supabase)
supabase/functions/manage-users/index.ts
                    add-person / reset-password function (paste into Supabase, Part 7)
```
