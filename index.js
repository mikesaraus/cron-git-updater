const git = require('simple-git'),
  cron = require('node-cron'),
  https = require('https'),
  fs = require('fs-extra'),
  path = require('path'),
  appRootPath = require('app-root-path'),
  { spawn, exec } = require('child_process')

const pkg = require('./package.json')

/**
 * @typedef {Object} CGU_Config - Configuration for Cron Git Updater
 * @property {String} repository - The url to the root of a git repository to update from, or /latest GitHub release.
 * @property {String} branch - The branch to update from. Defaults to master.
 * @property {Boolean} fromReleases - Updated based off of latest published GitHub release instead of branch package.json.
 * @property {String} token - A personal access token used for accessions private repositories.
 * @property {String} tempLocation - The local dir to save temporary information for Auto Git Update.
 * @property {Array[String]} ignoreFiles - An array of files to not install when updating. Useful for config files.
 * @property {Boolean} keepAllBackup - To keep all backup in separate folder, not overwrite previous backups.
 * @property {String} testing_dir - A test directory for testing so app will not overwrite all files.
 * @property {String} executeOnComplete - A command to execute after an update completes. Good for restarting the app.
 * @property {Boolean} exitOnComplete - Use process exit to stop the app after a successful update.
 */

/** @type {CGU_Config} */
let config = {}
let ready = true

// Subdirectories to use within the configured tempLocation from above.
const cloneSubdirectory = `/${pkg.name}/repo/`
const backupSubdirectory = `/${pkg.name}/backup/`

module.exports = class CronGitUpdate {
  /**
   * Create new Instance of Updater.
   *
   * @param {CGU_Config} newConfig
   */
  constructor(newConfig) {
    // Validate config has required properties
    if (newConfig == undefined && Object.prototype.toString.call(newConfig) !== '[object Object]')
      throw new Error('You must pass a valid config object.')
    if (newConfig.repository == undefined) throw new Error('You must include a repository link.')
    if (newConfig.branch == undefined) newConfig.branch = 'master'
    if (newConfig.tempLocation == undefined)
      throw new Error('You must define a temp location for cloning the repository')

    // Clean Repository URL
    newConfig.repository = this.genRepoURL(newConfig.repository)
    // Set Config
    config = newConfig

    if (config.fromReleases) {
      setBranchToReleaseTag(config.repository)
    }

    let file = path.join(appRootPath.path, 'package.json')
    if (!fs.existsSync(file)) throw new Error('Missing package.json')
    let appPackage = fs.readFileSync(file)
    appPackage = JSON.parse(appPackage)
    if (appPackage.name == pkg.name) throw new Error('Cron Git Updater is not being run as a dependency.')
  }

  /**
   * First check for an active internet connection then...
   *
   * Return false if no internet, else
   *
   * Will check local version against the remote version & then updates if different.
   */
  async update() {
    while (!ready) {
      await this.sleep(1000)
      log.info('Not ready to update...')
    }
    this.isOnline()
      .then(async () => {
        log.info('Checking update from the remote repository...')
        let versionCheck = await this.compareVersions()
        if (versionCheck.upToDate) {
          log.info('Local app is up to date.')
          return true
        } else if (!versionCheck.currentVersion || !versionCheck.remoteVersion) {
          log.error('Failed getting versions')
          return false
        } else return await this.forceUpdate()
      })
      .catch(() => {
        log.error('Cannot Update: No Active Internet Connection')
        return false
      })
  }

  /**
   * @typedef VersionResults
   * @param {Boolean} UpToDate - If the local version is the same as the remote version.
   * @param {String} currentVersion - The version of the local application.
   * @param {String} remoteVersion - The version of the application in the git repository.
   */

  /**
   * Checks the local version of the application against the remote repository.
   *
   * @returns {VersionResults} - An object with the results of the version comparison.
   */
  async compareVersions() {
    try {
      log.info('Getting local app version...')
      const appInfo = await this.readAppInfo()
      let currentVersion = appInfo ? appInfo.version : undefined
      log.info('Getting remote app version...')
      const remoteInfo = await this.readRemoteInfo(appInfo.repository.url)
      let remoteVersion = remoteInfo ? remoteInfo.version : null
      log[currentVersion ? 'info' : 'error']('Current Version: ' + currentVersion)
      log[remoteVersion ? 'info' : 'error']('Remote Version: ' + remoteVersion)
      return { upToDate: currentVersion == remoteVersion, currentVersion, remoteVersion }
    } catch (err) {
      log.error('Error comparing local and remote versions.')
      log.error(err)
      return {
        upToDate: false,
        currentVersion: undefined,
        remoteVersion: null,
      }
    }
  }

  /**
   * Reads the applications version from the package.json file.
   */
  async readAppInfo() {
    let file = path.join(appRootPath.path, 'package.json')
    log.info('Reading app information from ' + file)
    let appPackage = fs.readFileSync(file)
    return JSON.parse(appPackage)
  }

  /**
   * Reads the applications version from the git repository.
   *
   * @param {String} repo     Remote Repository Url
   * @param {String} branch   Remote branch to check
   * @param {String} token    For private repository
   */
  async readRemoteInfo() {
    // Generate request details
    const options = {}
    const url = this.genRepoURL(config.repository, 'raw', config.branch, 'package.json')
    if (config.token) options.headers = { Authorization: `token ${config.token}` }
    log.info('Reading remote information from ' + url)
    // Send request for repositories raw package.json file
    try {
      const body = await this.getHttpsRequest(url, options)
      return JSON.parse(body)
    } catch (err) {
      if ((err = 404)) log.error('This repository requires a token or does not exist. ' + url)
      else log.error(err)
      return
    }
  }

  /**
   * Downloads the update from the configured git repository.
   *
   * The repo is cloned to the configured tempLocation.
   */
  async remoteDownload() {
    // Inject token for private
    let repo = config.repository
    if (config.token) {
      repo = repo.replace('http://', '').replace('https://', '')
      repo = `https://${config.token}@${config.repository}`
    }

    // Empty destination directory & clone repo
    let destination = path.join(config.tempLocation, cloneSubdirectory)
    log.info('Cloning ' + repo)
    log.info('Destination: ' + destination)
    await fs.ensureDir(destination)
    await fs.emptyDir(destination)
    await this.gitClone(repo, destination, config.branch)
    return true
  }

  /**
   * Clones the git repository, purges ignored files, and installs the update over the local application.
   * A backup of the application is created before the update is installed.
   * If configured, a completion command will be executed and the process for the app will be stopped.
   * @returns {Boolean} The result of the update.
   */
  async forceUpdate() {
    try {
      ready = false
      log.info('Updating application from ' + config.repository)
      await downloadUpdate()
      await backupApp()
      await installUpdate()
      await installDependencies()
      log.info('Finished installing updated version.')
      if (config.executeOnComplete) await this.blindExecute(config.executeOnComplete)
      if (config.exitOnComplete) process.exit(1)
      return true
    } catch (err) {
      log.error('Error updating application')
      log.error(err)
      return false
    } finally {
      ready = true
    }
  }

  /**
   * Schedule a task
   *
   * @param {String} cron_expression Schedule when the task should run.
   *
   * Validate the expression using .{@link validateSchedule}()
   *
   * @param {string} timezone The timezone that is used for job scheduling. Default is `Asia/Manila`
   */
  async schedule(cron_expression, timezone) {
    if (!cron_expression) throw new Error('Cron Expression is Required')
    if (!this.validateSchedule(cron_expression)) throw new Error('Cron Syntax Error')
    if (!timezone) timezone = process.env.TZ || 'Asia/Manila'
    cron.schedule(
      cron_expression,
      () => {
        log.info('Running Scheduled task...')
        this.update()
      },
      { scheduled: true, timezone: timezone }
    )
  }

  /**
   * Validate Cron Expression
   *
   * Allowed fields
   * ```js
   *  # ┌────────────── second (optional)
   *  # │ ┌──────────── minute
   *  # │ │ ┌────────── hour
   *  # │ │ │ ┌──────── day of month
   *  # │ │ │ │ ┌────── month
   *  # │ │ │ │ │ ┌──── day of week
   *  # │ │ │ │ │ │
   *  # │ │ │ │ │ │
   *  # * * * * * *
   * ```
   */
  validateSchedule(cron_expression) {
    if (!cron_expression) throw new Error('Cron Expression is Required')
    return cron.validate(cron_expression)
  }

  /**
   * Clone a repository with `simple-git`
   *
   * @param {String} repo - The url of the repository to clone.
   * @param {String} destination - The local path to clone into.
   * @param {String} branch - The repo branch to clone.
   */
  gitClone = gitClone

  /**
   * A promise wrapper for the child-process spawn function. Does not listen for results.
   *
   * @param {String} command - The command to execute.
   */
  blindExecute(command) {
    return new Promise(function (resolve, reject) {
      spawn(command, [], { shell: true, detached: true })
      setTimeout(resolve, 1000)
    })
  }

  /**
   * A promise wrapper for sending a get https requests.
   *
   * @param {String} url - The Https address to request.
   * @param {String} options - The request options.
   */
  getHttpsRequest(url, options) {
    return new Promise(function (resolve, reject) {
      let req = https.request(url, options, (res) => {
        //Construct response
        let body = ''
        res.on('data', (data) => {
          body += data
        })
        res.on('end', function () {
          if (res.statusCode == '200') return resolve(body)
          log.error('Bad Response ' + res.statusCode)
          reject(res.statusCode)
        })
      })
      log.info('Sending request to ' + url)
      log.info('Options: ' + JSON.stringify(options))
      req.on('error', reject)
      req.end()
    })
  }

  /**
   * Generate Git Repo URL
   *
   * @param {String} repo Repository url
   * @param {'raw' | 'release'} type Type of url to generate
   * @param {String?} branch Branch to use: `required` if type is `raw`
   * @param {String?} file Raw file to access: `required` if type is `raw`
   * @returns {String} Clean url for specified type
   */
  genRepoURL(repo, type, branch, file) {
    if (!repo) throw new Error('Repository is required')
    if (type == 'raw' && !file) throw new Error('File is required when using raw type')
    if (type == 'raw' && !branch) throw new Error('Branch is required when using raw type')
    let url = repo.toLowerCase()
    // Branch Default is using release for production otherwise development
    if (url.startsWith('git+')) url = url.slice(4)
    if (url.endsWith('/')) url = url.slice(0, -1)
    if (url.endsWith('.git')) url = url.slice(0, -4)
    switch (type) {
      case 'raw':
        // Git Raw URL for Supported Library
        if (url.includes('gitlab')) url = `${url}/-/raw/${branch}/${file}`
        if (url.includes('github')) url = `${url.replace('github.com', 'raw.githubusercontent.com')}/${branch}/${file}`
        break

      case 'release':
        // Git Raw URL for Supported Library
        if (url.includes('github')) url = `${url.replace('github.com/', 'api.github.com/repos/')}releases/latest`
        break
    }
    return url
  }

  /**
   *
   * @typedef {Object} InternetCheckerConfig     Settings to check
   * @property {Number} timeout             Execution time in milliseconds
   * @property {Number} retries             Total query attempts made during timeout
   * @property {String} domainName          Domain to check for connection by default google.com
   * @property {Number} port                Port where the DNS lookup should check by default 53
   * @property {String} host                DNS Host where lookup should check by default '8.8.8.8' (Google Public DNS)
   */

  /**
   * Internet available is a very simple method that allows you to check if there's an active
   * internet connection by resolving a DNS address and it's developer friendly.
   *
   * @param {InternetCheckerConfig} config
   * @returns {Promise<void>} True if online
   */
  isOnline(config = {}) {
    const dns = require('dns-socket')

    return new Promise(function (resolve, reject) {
      // Create instance of the DNS resolver
      const socket = dns({
        timeout: config.timeout || 5000,
        retries: config.retries || 5,
      })

      // Run the dns lowlevel lookup
      socket.query(
        {
          questions: [
            {
              type: 'A',
              name: config.domainName || 'google.com',
            },
          ],
        },
        config.port || 53,
        config.host || '8.8.8.8'
      )

      // DNS Address solved, internet available
      socket.on('response', () => {
        socket.destroy(() => {
          resolve()
        })
      })

      // Verify for timeout of the request (cannot reach server)
      socket.on('timeout', () => {
        socket.destroy(() => {
          reject()
        })
      })
    })
  }

  /**
   *  Put a proccess on sleep for a specific time
   *
   * @param {Number} time sleep duration in `milliseconds`
   */
  sleep(time) {
    return new Promise(function (resolve, reject) {
      setTimeout(resolve, time)
    })
  }
}

////////////////////////////
// HELPER & MISC FUNCTIONS

/**
 * Console Log in color base on message type
 */
const log = {
  /**
   * Log information `green`
   *
   * @param {Object | String} message A message to log can be and object or a string
   */
  info: (message) => {
    console.log(
      '\x1b[32m%s\x1b[0m', // green
      '[' + new Date() + '] [' + pkg.displayName + ']', // Timestamp and Log Type
      typeof message == 'object' ? JSON.stringify(message) : message // Message
    )
  },
  /**
   * Log warning `yellow`
   *
   * @param {Object | String} message A message to log can be and object or a string
   */
  warning: (message) => {
    console.log(
      '\x1b[33m%s\x1b[0m', // yellow
      '[' + new Date() + '] WARNING [' + pkg.displayName + ']', // Timestamp and Log Type
      typeof message == 'object' ? JSON.stringify(message) : message // Message
    )
  },
  /**
   * Log error `red`
   *
   * @param {Object | String} message A message to log can be and object or a string
   * @param {Boolean} trace To log only error message stack, if `message` is an instance of Error
   */
  error: (message, trace = true) => {
    if (trace && message instanceof Error) message = message.stack
    console.log(
      '\x1b[31m%s\x1b[0m', // red
      '[' + new Date() + '] ERROR [' + pkg.displayName + ']', // Timestamp and Log Type
      typeof message == 'object' ? JSON.stringify(message) : message // Message
    )
  },
}

/**
 * Creates a backup of the application, including node modules.
 * The backup is stored in the configured tempLocation.
 */
async function backupApp() {
  let destination = path.join(config.tempLocation, backupSubdirectory)
  if (config.keepAllBackup !== false) destination = path.join(destination, Date.now())
  log.info('Backing up app to ' + destination)
  await fs.ensureDir(destination)
  await fs.copy(appRootPath.path, destination, { dereference: true })
  return true
}

/**
 * Downloads the update from the configured git repository.
 * The repo is cloned to the configured tempLocation.
 */
async function downloadUpdate() {
  // Inject token for private repositories
  let repo = config.repository
  if (config.token) {
    repo = repo.replace('http://', '').replace('https://', '')
    repo = `https://${config.token}@${repo}`
  }

  // Empty destination directory & clone repo
  let destination = path.join(config.tempLocation, cloneSubdirectory)
  log.info('Cloning ' + repo)
  log.info('Destination: ' + destination)
  await fs.ensureDir(destination)
  await fs.emptyDir(destination)
  await gitClone(repo, destination, config.branch)
  return true
}

/**
 * Runs npm install to update/install application dependencies.
 */
function installDependencies() {
  return new Promise(function (resolve, reject) {
    //If testing is enabled, use alternative path to prevent overwrite of app.
    let destination = config.testing_dir ? path.join(appRootPath.path, config.testing_dir) : appRootPath.path
    log.info('Installing application dependencies in ' + destination)
    // Generate and execute command
    let command = `cd ${destination} && npm install`
    let child = exec(command)

    // Wait for results
    child.stdout.on('end', resolve)
    child.stdout.on('data', (data) => log.info('npm install: ' + data.replace(/\r?\n|\r/g, '')))
    child.stderr.on('data', (data) => {
      if (data.toLowerCase().includes('error')) {
        // npm passes warnings as errors, only reject if "error" is included
        data = data.replace(/\r?\n|\r/g, '')
        log.error('Error installing dependencies')
        log.error('' + data)
        reject()
      } else {
        log.info('' + data)
      }
    })
  })
}

/**
 * Purge ignored files from the update, copy the files to the app directory, and install new modules
 *
 * The update is installed from  the configured tempLocation.
 */
async function installUpdate() {
  // Remove ignored files from the new version
  if (config.ignoreFiles) {
    log.info('Purging ignored files from the update')
    config.ignoreFiles.forEach((file) => {
      file = path.join(config.tempLocation, cloneSubdirectory, file)
      if (fs.existsSync(file)) {
        log.info('Removing ' + file)
        fs.unlinkSync(file)
      }
    })
  }
  // Install updated files
  let source = path.join(config.tempLocation, cloneSubdirectory)
  //If testing is enabled, use alternative path to prevent overwrite of app.
  let destination = config.testing_dir ? path.join(appRootPath.path, config.testing_dir) : appRootPath.path
  log.info('Auto Git Update - Installing update...')
  log.info('Auto Git Update - Source: ' + source)
  log.info('Auto Git Update - Destination: ' + destination)
  await fs.ensureDir(destination)
  await fs.copy(source, destination)
  return true
}

/**
 * Updates the configuration for this updater to use the latest release as the repo branch
 *
 * @param {String} repository - The link to the repo
 */
async function setBranchToReleaseTag(repository) {
  // Validate the configuration & generate request details
  let options = { headers: { 'User-Agent': pkg.displayName + ' - ' + repository } }
  if (config.token) options.headers.Authorization = `token ${config.token}`
  repository = this.genRepoURL(repository, 'release')
  if (!repository.includes('github'))
    throw new Error('fromReleases is enabled but this does not seem to be a GitHub repo.')
  if (repository.endsWith('/')) repository = repository.slice(0, -1)
  const url = repository + '/releases/latest'
  log.info('Checking release tag from ' + url)
  // Attempt to identify the tag/version of the latest release
  try {
    let body = await this.getHttpsRequest(url, options)
    let response = JSON.parse(body)
    let tag = response.tag_name
    config.branch = tag
  } catch (err) {
    if ((err = 404)) throw new Error('This repository requires a token or does not exist. \n ' + url)
    throw err
  }
}

/**
 * Clone a repository with `simple-git`
 *
 * @param {String} repo - The url of the repository to clone.
 * @param {String} destination - The local path to clone into.
 * @param {String} branch - The repo branch to clone.
 */
function gitClone(repo, destination, branch) {
  return new Promise(function (resolve, reject) {
    git().clone(repo, destination, [`--branch=${branch}`], (result) => {
      if (result != null) reject(`Unable to clone repository\n ${repo}\n ${result}`)
      resolve()
    })
  })
}
