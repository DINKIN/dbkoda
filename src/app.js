/**
 * @Last modified by:   guiguan
 * @Last modified time: 2017-12-05T14:43:11+11:00
 *
 * dbKoda - a modern, open source code editor, for MongoDB.
 * Copyright (C) 2017-2018 Southbank Software
 *
 * This file is part of dbKoda.
 *
 * dbKoda is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * dbKoda is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with dbKoda.  If not, see <http://www.gnu.org/licenses/>.
 */

import _ from 'lodash';
import path from 'path';
import sh from 'shelljs';
import childProcess from 'child_process';
import { app, BrowserWindow, Menu, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import moment from 'moment';
import winston from 'winston';
import { ipcMain } from 'electron';

import { downloadDrill, downloadDrillController } from './drill';

import { identifyWorkingMode, invokeApi, getAvailablePort } from './helpers';
import touchbar from './touchbar';

process.env.NODE_CONFIG_DIR = path.resolve(__dirname, '../config/');
const config = require('config');

identifyWorkingMode();

if (global.MODE !== 'prod') {
  // in non-production mode, enable source map for stack tracing
  require('source-map-support/register');
  process.env.NODE_ENV = 'development';
} else {
  process.env.NODE_ENV = 'production';
}

let modeDescription;
if (global.MODE == 'byo') {
  modeDescription = 'Bring Your Own (BYO) Dev';
} else if (global.MODE == 'dev') {
  modeDescription = 'Dev';
} else if (global.MODE == 'super_dev') {
  modeDescription = 'Super Dev';
} else {
  modeDescription = 'Production';
}

global.UAT = process.env.UAT === 'true';
global.LOADER = process.env.LOADER !== 'false';

global.NAME = app.getName();
global.APP_VERSION = app.getVersion();
global.PATHS = (() => {
  const userHome = app.getPath('home');
  const home = path.resolve(userHome, `.${global.NAME}`);
  const userData = app.getPath('userData');
  const configPath = process.env.CONFIG_PATH
    ? process.env.CONFIG_PATH
    : path.resolve(home, 'config.yml');
  const profilesPath = process.env.PROFILES_PATH
    ? process.env.CONFIG_PATH
    : path.resolve(home, 'profiles.yml');

  // [IMPORTANT] Please read the comment of next `IMPORTANT` tag
  return {
    home,
    userData,
    userHome,
    configPath: global.UAT ? '/tmp/config.yml' : configPath,
    profilesPath: global.UAT ? '/tmp/profiles.yml' : profilesPath,
    logs: path.resolve(userData, 'logs'),
    stateStore: global.UAT
      ? '/tmp/stateStore.json'
      : path.resolve(home, 'stateStore.json')
  };
})();

global.getRandomPort = (startPortRange, endPortRange, host) => {
  return getAvailablePort(startPortRange, endPortRange, host);
};

// TODO create an uninstaller
// ensure paths exist.
// [IMPORTANT] Remember to add exceptions here
sh.mkdir(
  '-p',
  _.values(_.omit(global.PATHS, ['stateStore', 'configPath', 'profilesPath']))
);

const configWinstonLogger = () => {
  const commonOptions = {
    colorize: 'all',
    timestamp() {
      return moment().format();
    }
  };

  const transports = [new winston.transports.Console(commonOptions)];

  if (global.MODE === 'prod' && !global.UAT) {
    require('winston-daily-rotate-file');
    transports.push(
      new winston.transports.DailyRotateFile(
        _.assign({}, commonOptions, {
          filename: path.resolve(global.PATHS.logs, 'app.log'),
          datePattern: 'yyyy-MM-dd.',
          localTime: true,
          prepend: true,
          json: false
        })
      )
    );
  }

  global.l = new winston.Logger({
    level: config.get('loggerLevel'),
    // level: 'debug',
    padLevels: true,
    levels: {
      error: 0,
      warn: 1,
      notice: 2,
      info: 3,
      debug: 4
    },
    colors: {
      error: 'red',
      warn: 'yellow',
      notice: 'green',
      info: 'black',
      debug: 'blue'
    },
    transports
  });

  process.on('unhandledRejection', (reason) => {
    l.error(reason);
  });

  process.on('uncaughtException', (err) => {
    l.error(err.stack);
  });
};
configWinstonLogger();

l.notice(`Starting up with ${modeDescription} mode...`);

// Launch dbKoda Controller
let controllerProcess;
const configController = () => {
  const controllerPath = require.resolve('../assets/controller');

  // NOTE: cwd option is not supported in asar, please avoid using it
  controllerProcess = childProcess.fork(controllerPath, [], {
    env: _.assign({}, process.env, {
      LOG_PATH: path.resolve(global.PATHS.logs, 'controller.log'),
      MONGO_SCRIPTS_PATH: path.resolve(
        app.getAppPath(),
        '../app.asar.unpacked/assets/controller/lib/'
      ),
      UAT: global.UAT,
      CONFIG_PATH: global.UAT
        ? '/tmp/config.yml'
        : path.resolve(global.PATHS.home, 'config.yml')
    })
  });

  if (!global.UAT) {
    // only handle once all together
    const errorHandled = false;
    const handleControllerError = (err, signal) => {
      if (errorHandled || err === 0 || signal === 'SIGINT') return;

      let msg;

      if (err === null) {
        msg = 'got killed unexpectedly';
      } else if (typeof err === 'number') {
        msg = 'exited with error';
      } else {
        msg = `failed: ${err.message || String(err)}`;
      }

      dialog.showErrorBox(
        'Error:',
        `controller ${msg}, please check logs at https://goo.gl/fGcFmv and report this issue`
      );
    };

    controllerProcess.on('error', handleControllerError);
    controllerProcess.on('exit', handleControllerError);
  }

  l.info(`Controller process PID: ${controllerProcess.pid}`);
};
const quitController = () => {
  if (!controllerProcess) return;

  controllerProcess.removeAllListeners();
  controllerProcess.kill();
  controllerProcess = null;
};
if (global.MODE !== 'byo') {
  configController();
}

const newEditor = () => {
  const activeWindow = BrowserWindow.getFocusedWindow();
  if (activeWindow) {
    activeWindow.webContents.send('command', 'newEditor');
  }
};

const openFileInEditor = () => {
  const activeWindow = BrowserWindow.getFocusedWindow();
  if (activeWindow) {
    activeWindow.webContents.send('command', 'openFile');
  }
};

const saveFileInEditor = () => {
  const activeWindow = BrowserWindow.getFocusedWindow();
  if (activeWindow) {
    activeWindow.webContents.send('command', 'saveFile');
  }
};

const saveFileAsInEditor = () => {
  const activeWindow = BrowserWindow.getFocusedWindow();
  if (activeWindow) {
    activeWindow.webContents.send('command', 'saveFileAs');
  }
};

const openPreferences = () => {
  const activeWindow = BrowserWindow.getFocusedWindow();
  if (activeWindow) {
    activeWindow.webContents.send('command', 'openPreferences');
  }
};

const handleDrillRequest = (event, arg) => {
  if (arg == 'downloadDrill') {
    downloadDrill()
      .then(() => {
        event.sender.send('drillResult', 'downloadDrillComplete');
      })
      .catch((reason) => {
        console.log('Error: ', reason);
      });
  } else if (arg == 'downloadController') {
    downloadDrillController()
      .then(() => {
        event.sender.send('drillResult', 'downloadDrillControllerComplete');
      })
      .catch((reason) => {
        console.log('Error: ', reason);
      });
  }
};

// Create main window with React UI
const createWindow = (url, options) => {
  options = _.assign(
    {
      width: 1280,
      height: 900,
      backgroundColor: '#363951'
    },
    options
  );
  const win = new BrowserWindow(options);

  win.loadURL(url);

  win.on('closed', () => {
    win.destroy();
  });

  return win;
};

const createMainWindow = () => {
  const url =
    global.MODE === 'byo' || global.MODE === 'super_dev'
      ? 'http://localhost:3000/ui/'
      : 'http://localhost:3030/ui/';

  if (global.UAT || !global.LOADER) {
    invokeApi(
      { url },
      {
        shouldRetryOnError(e) {
          return _.includes(
            ['ECONNREFUSED', 'ECONNRESET', 'ESOCKETTIMEDOUT'],
            e.error.code || _.includes([404, 502], e.statusCode)
          );
        },
        errorHandler(err) {
          l.error(err.stack);
          throw err;
        }
      }
    ).then(() => {
      const mainWindow = createWindow(url);

      const handleAppCrashed = () => {
        mainWindow.reload();
      };
      global.mainWindowId = mainWindow.id;
      ipcMain.once('appCrashed', handleAppCrashed);

      ipcMain.on('drill', handleDrillRequest);

      mainWindow.on('closed', () => {
        ipcMain.removeListener('appCrashed', handleAppCrashed);
        ipcMain.removeListener('drill', handleDrillRequest);
      });
    });
    return;
  }

  // show a splash screen
  const splashWindow = createWindow(
    `file://${path.resolve(__dirname, '../assets/splash/index.html')}`
  );

  // wait for uiUrl to become reachable and then show real main window
  // const uiPath = require.resolve('@southbanksoftware/dbkoda-ui');
  invokeApi(
    {
      url
    },
    {
      shouldRetryOnError(e) {
        return (
          !splashWindow.isDestroyed() &&
          (_.includes(
            ['ECONNREFUSED', 'ECONNRESET', 'ESOCKETTIMEDOUT'],
            e.error.code
          ) ||
            _.includes([404, 502], e.statusCode))
        );
      },
      errorHandler(err) {
        if (splashWindow.isDestroyed()) {
          return;
        }
        l.error(err.stack);
        throw err;
      }
    }
  ).then(() => {
    if (splashWindow.isDestroyed()) {
      return;
    }

    const mainWindow = createWindow(url, {
      show: false
    });

    global.mainWindowId = mainWindow.id;

    const handleAppCrashed = () => {
      dialog.showMessageBox({
        title: 'Error',
        message:
          'Sorry! your previous configuration (stateStore) was incompatible with current version.',
        buttons: ['OK'],
        detail:
          'We have made a backup of your old configuration, and created a new one. Please see http://goo.gl/t28EzL for more details.'
      });
      mainWindow.reload();
    };

    const handleAppReady = () => {
      if (splashWindow.isDestroyed()) {
        mainWindow.destroy();
        return;
      }
      if (splashWindow.isFullScreen()) {
        splashWindow.hide();
        mainWindow.setFullScreen(true);
      } else {
        mainWindow.setBounds(splashWindow.getBounds());
        if (splashWindow.isMinimized()) {
          mainWindow.minimize();
        } else {
          mainWindow.show();
        }
      }
      splashWindow.destroy();
      mainWindow.setTouchBar(touchbar);
      if (
        global.MODE === 'prod' &&
        (process.platform === 'darwin' || process.platform === 'win32')
      ) {
        checkForUpdates(false);
      }
    };

    // TODO needs to assign each event a windows id if we are going to support multiple windows
    ipcMain.once('appReady', handleAppReady);
    ipcMain.once('appCrashed', handleAppCrashed);

    ipcMain.on('drill', handleDrillRequest);

    mainWindow.on('closed', () => {
      ipcMain.removeListener('appReady', handleAppReady);
      ipcMain.removeListener('appCrashed', handleAppCrashed);
      ipcMain.removeListener('drill', handleDrillRequest);
    });
  });
};

// Configure Auto-Updater
autoUpdater.logger = l;
autoUpdater.autoDownload = false;
global.checkUpdateEnabled = true;
global.userCheckForUpdate = false;

global.DownloadUpdate = () => {
  return new Promise((resolve, reject) => {
    dialog.showMessageBox(
      {
        type: 'info',
        title: 'Found Updates',
        message: 'Found updates, do you want update now?',
        buttons: ['Sure', 'No']
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          autoUpdater.downloadUpdate();
          resolve(true);
        } else {
          reject(false); // eslint-disable-line prefer-promise-reject-errors
        }
      }
    );
  });
};
global.InstallUpdate = () => {
  return new Promise((resolve, reject) => {
    dialog.showMessageBox(
      {
        type: 'info',
        title: 'Install Updates',
        message:
          'Updates downloaded, application will update on next restart, would you like to restart now?',
        buttons: ['Sure', 'Later']
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          setImmediate(() => autoUpdater.quitAndInstall());
          resolve(true);
        } else {
          reject(false); // eslint-disable-line prefer-promise-reject-errors
        }
      }
    );
  });
};
const getMainWindow = () => {
  if (global.mainWindowId) {
    return BrowserWindow.fromId(global.mainWindowId);
  }
  return null;
};
autoUpdater.on('checking-for-update', () => {
  l.notice('Checking for update...');
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send('updateStatus', 'CHECKING');
  }
});
autoUpdater.on('update-available', () => {
  l.notice('Update available.');

  if (global.userCheckForUpdate) {
    dialog.showMessageBox(
      {
        type: 'info',
        title: 'Found Updates',
        message: 'Found updates, do you want update now?',
        buttons: ['Sure', 'No']
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          autoUpdater.downloadUpdate();
        } else {
          global.checkUpdateEnabled = true;
        }
      }
    );
  }
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send('updateStatus', 'AVAILABLE');
  }
});
autoUpdater.on('update-not-available', () => {
  l.notice('Update not available.');
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send('updateStatus', 'NOT_AVAILABLE');
  }
  if (global.userCheckForUpdate) {
    dialog.showMessageBox({
      title: 'No Updates',
      message: 'Current version is up-to-date.'
    });
  }
  global.checkUpdateEnabled = true;
});
autoUpdater.on('error', (event, error) => {
  l.notice('Error in auto-updater. ', (error.stack || error).toString());
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send('updateStatus', 'ERROR');
  }
  if (global.userCheckForUpdate) {
    dialog.showErrorBox(
      'Error: ',
      'Unable to download update at the moment, Please try again later.'
    );
  }
  global.checkUpdateEnabled = true;
});
autoUpdater.on('download-progress', (progressObj) => {
  let logMessage = 'Download speed: ' + progressObj.bytesPerSecond;
  logMessage = logMessage + ' - Downloaded ' + progressObj.percent + '%';
  logMessage =
    logMessage + ' (' + progressObj.transferred + '/' + progressObj.total + ')';
  l.notice(logMessage);
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send(
      'updateStatus',
      'DOWNLOADING ' + Math.round(progressObj.percent) + '%'
    );
  }
});
autoUpdater.on('update-downloaded', () => {
  l.notice('Update downloaded; will install on quit');
  if (global.userCheckForUpdate) {
    dialog.showMessageBox(
      {
        type: 'info',
        title: 'Install Updates',
        message:
          'Updates downloaded, application will update on next restart, would you like to restart now?',
        buttons: ['Sure', 'Later']
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          setImmediate(() => autoUpdater.quitAndInstall());
        } else {
          global.checkUpdateEnabled = true;
        }
      }
    );
  }
  const activeWindow = getMainWindow();
  if (activeWindow) {
    activeWindow.webContents.send('updateStatus', 'DOWNLOADED');
  }
});
function checkForUpdates(bShowDialog = true) {
  global.checkUpdateEnabled = false;
  global.userCheckForUpdate = bShowDialog;
  /* if (process.platform === 'win32' && os.arch() === 'ia32') {
    const s3Options = {
      provider: 's3',
      bucket: 'updates.dbkoda.32bit',
      region: 'ap-southeast-2',
    };
    autoUpdater.setFeedURL(s3Options);
  } */
  autoUpdater.checkForUpdates();
}
function aboutDBKoda() {
  let strAbout = 'Version ';
  strAbout += global.APP_VERSION;
  strAbout += '\n\n';
  strAbout += 'Copyright © 2018 Southbank Software';
  dialog.showMessageBox(
    {
      title: 'About dbKoda',
      message: strAbout
    },
    () => {}
  );
}
// Set app menu
const setAppMenu = () => {
  const menus = [
    {
      role: 'editMenu'
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'resetzoom' },
        { role: 'zoomin' },
        { role: 'zoomout' }
      ]
    },
    {
      label: 'Development',
      submenu: [
        {
          label: 'Reload UI',
          accelerator: 'Ctrl+Alt+Cmd+R',
          role: 'forcereload'
        },
        {
          label: 'Reload Controller',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => {
            quitController();
            configController();
          },
          enabled: global.MODE !== 'byo'
        },
        {
          label: 'Toggle DevTools',
          accelerator: 'Alt+CmdOrCtrl+I',
          role: 'toggledevtools'
        }
      ]
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    menus.unshift({
      label: 'File',
      submenu: [
        {
          label: 'New Editor',
          accelerator: 'CmdOrCtrl+N',
          click() {
            newEditor();
          }
        },
        {
          label: 'Open File',
          accelerator: 'CmdOrCtrl+O',
          click() {
            openFileInEditor();
          }
        },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click() {
            saveFileInEditor();
          }
        },
        {
          label: 'Save File As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click() {
            saveFileAsInEditor();
          }
        },
        { role: 'close' }
      ]
    });
    menus.unshift({
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates',
          click: () => {
            checkForUpdates();
          },
          enabled:
            global.checkUpdateEnabled &&
            (global.MODE === 'prod' || global.mode === 'byo')
        },
        { type: 'separator' },
        {
          label: 'Preferences',
          click: () => {
            openPreferences();
          },
          accelerator: 'CmdOrCtrl+,'
        },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
    menus.push({
      label: 'Help',
      role: 'help',
      submenu: []
    });
  } else {
    menus.unshift({
      label: 'File',
      submenu: [
        {
          label: 'New Editor',
          accelerator: 'CmdOrCtrl+N',
          click() {
            newEditor();
          }
        },
        {
          label: 'Open File',
          accelerator: 'CmdOrCtrl+O',
          click() {
            openFileInEditor();
          }
        },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click() {
            saveFileInEditor();
          }
        },
        {
          label: 'Save File As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click() {
            saveFileAsInEditor();
          }
        },
        {
          label: 'Preferences',
          click() {
            openPreferences();
          },
          accelerator: 'CmdOrCtrl+,'
        },
        { role: 'close' }
      ]
    });
    menus.push({
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'About',
          click: () => {
            aboutDBKoda();
          }
        },
        {
          label: 'Check for Updates',
          click: () => {
            checkForUpdates();
          },
          enabled: global.checkUpdateEnabled && global.MODE === 'prod'
        }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
};

// Install/upgrade devtools extensions
// TODO installed extensions should be remembered but this is not the case with electron
// 1.8.2-beta.2, so we install them explicitly here as a workaround
const installDevToolsExtensions = () => {
  const {
    default: installExtension,
    REACT_DEVELOPER_TOOLS
  } = require('electron-devtools-installer');

  installExtension(REACT_DEVELOPER_TOOLS)
    .then(name => l.info(`Added DevTools Extension: ${name}`))
    .catch(l.error);

  installExtension({
    id: 'pfgnfdagidkfgccljigdamigbcnndkod',
    electron: '^1.2.1'
  })
    .then(name => l.info(`Added DevTools Extension: ${name}`))
    .catch(l.error);

  if (!BrowserWindow.getDevToolsExtensions().devtron) {
    try {
      BrowserWindow.addDevToolsExtension(
        path.resolve(__dirname, '../node_modules/devtron')
      );
      l.info('Added DevTools Extension: Devtron');
    } catch (err) {
      l.error(err);
    }
  }
};

app.on('ready', () => {
  setAppMenu();

  if (!global.UAT && global.MODE !== 'prod') {
    installDevToolsExtensions();
  }

  createMainWindow();
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('will-quit', () => {
  l.notice('Shutting down...');
  quitController();
});
