# Cronjob Update Git

Git clone a repo into a folder and schedule a cron job to pull updates from the remote origin.

# Installation

```bash
npm install cron-git-updater
```

# Usage

```js
const CGU = require('cron-git-updater')

// const CGU_Config = {
//   repository: 'github or gitlab link',
//   branch: 'main',
//   fromReleases: false,
//   token: 'for private repository',
//   tempLocation: '../history',
//   ignoreFiles: [''],
//   keepAllBackup: true,
//   testing_dir: 'testing',
//   executeOnComplete: './run-on-update.sh',
//   exitOnComplete: false,
// }

const newUpdater = new CGU({
  repository: 'https://gitlab.com/mikesaraus/expsql_rtapi.git',
  branch: 'development',
  tempLocation: '../history',
})

// Schedule a task to update the repository
// It uses .update() function
// Check is performed and won't update if same version
newUpdater.schedule('0 0 * * *', 'Asia/Manila')

// Call the updater manually
// It first check for internect connection
// Then check if local version does not match
// from remote version
newUpdater.update()

// Call the updater manually and force update
// No check is done it will force to use
// the remote version of the app
newUpdater.forceUpdate()
```

# API

## .schedule(cron_syntax, timezone)

Task scheduler based on timezone

### <b>Params</b>

- `cron_syntax` - Schedule when the task should run. e.g. `'0 0 * * *'` (schedule every 12am)

```bash
# ┌────────────── second (optional)
# │ ┌──────────── minute
# │ │ ┌────────── hour
# │ │ │ ┌──────── day of month
# │ │ │ │ ┌────── month
# │ │ │ │ │ ┌──── day of week
# │ │ │ │ │ │
# │ │ │ │ │ │
# * * * * * *
```

- `timezone` - The timezone that is used for job scheduling. Default is `Asia/Manila`

## .update()

Update the repository

Some check is performed to insure success

- Check if machine has active internet connection
- call .compareVersions() if update is needed

## .compareVersions()

Compare check `local` version and `remote` version

## .readAppInfo()

Read local app `package.json`

## .readRemoteInfo()

Read remote repository `package.json`

## .remoteDownload()

Download remote repository

## .forceUpdate()

Force update the local project from remote repository
