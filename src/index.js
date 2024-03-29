#!/usr/bin/env node

import commandLineArgs from 'command-line-args';
import jsYaml from 'js-yaml';
import fs from 'graceful-fs';
import path from 'path';
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import { execSync, exec } from 'child_process'; // eslint-disable-line
// subcommands
import { listExpTemplates, getExpTemplate, copyExpTemplate, getJsPsychTimeline, getJsPsychPlugins, getJsPsychImports } from './commands/experiments/index.js';
import { listSiteTemplates, getPushkinSite, copyPushkinSite } from './commands/sites/index.js';
import { awsInit, nameProject, addIAM, awsArmageddon, awsList, createAutoScale } from './commands/aws/index.js'
//import prep from './commands/prep/index.js'; //has to be separate from other imports from prep/index.js; this is the default export
import {prep, setEnv} from './commands/prep/index.js';
import { setupdb, setupTestTransactionsDB } from './commands/setupdb/index.js';
import * as compose from 'docker-compose'
import { Command } from 'commander'
import inquirer from 'inquirer'
import got from 'got';
const shell = require('shelljs');

const version = require("../package.json").version


const program = new Command();
program.version(version);


const moveToProjectRoot = () => {
  // better checking to make sure this is indeed a pushkin project would be goodf
  while (process.cwd() != path.parse(process.cwd()).root) {
    if (fs.existsSync(path.join(process.cwd(), 'pushkin.yaml'))) return;
    process.chdir('..');
  }
  console.error('No pushkin project found here or in any above directories');
  process.exit();
};

const loadConfig = (configFile) => {
  // could add some validation to make sure everything expected in the config is there
  return new Promise((resolve, reject) => {
    try { 
      resolve(jsYaml.safeLoad(fs.readFileSync(configFile, 'utf8')));
    } catch (e) { 
      console.error(`Pushkin config file missing, error: ${e}`); 
      process.exit(); 
    }
  })
};


const updateS3 = async () => {
  let awsName, useIAM
  try {
    let awsResources = jsYaml.safeLoad(fs.readFileSync(path.join(process.cwd(), 'awsResources.js'), 'utf8'));
    awsName = awsResources.awsName
    useIAM = awsResources.iam
  } catch (e) {
    console.error(`Unable to read deployment config`)
    throw e
  }    

  let syncMe
  try {
    return syncS3(awsName, useIAM)
  } catch(e) {
    console.error(`Unable to sync local build with s3 bucket`)
    throw e
  }  
}

const dockerLogin = async () => {
  //get dockerhub id
  let DHID
  try {
    let config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'))
    DHID = config.DockerHubID
  } catch (e) {
    console.error(`Unable to load pushkin.yaml`)
    throw e
  }

  if (DHID == '') {
    throw new Error(`Your DockerHub ID has disappeared from pushkin.yaml.\n I am not sure how that happened.\n
      If you run '$ pushkin setDockerHub' and then retry aws update, it might work. Depending on exactly why your DockerHub ID wasn't in pushkin.yaml.`)
  }

  try {
    console.log(`Confirming docker login.`)
    execSync(`cat .docker | docker login --username ${DHID} --password-stdin`)
  } catch (e) {
    console.error(`Automatic login to DockerHub failed. This might be because your ID or password are wrong.\n
      Try running '$ pushkin setDockerHub' and reset then try again.\n
      If that still fails, report an issue to Pushkin on GitHub. In the meantime, you can probably login manually\n
      by typing '$ docker login' into the console.\n Provide your username and password when asked.\n
      Then try '$ pushkin aws update' again.`)
    process.exit()
  }

  return(DHID)
}

const updateDocker = async () => {

  let DHID = await dockerLogin();

  try {
    return publishToDocker(DHID);
  } catch(e) {
    console.error('Unable to publish images to DockerHub')
    throw e
  }
}

const updateMigrations = async () => {
  let experimentsDir, productionDBs
  try {
    let config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'))
    experimentsDir = config.experimentsDir
    productionDBs = config.productionDBs
  } catch (e) {
    console.error(`Unable to load pushkin.yaml`)
    throw e
  }
  console.log(`Handling migrations`)
  let ranMigrations, dbsToExps
  try {
    dbsToExps = await getMigrations(path.join(process.cwd(), experimentsDir), true)
  } catch (e) {
    console.error(`Unable to run database migrations`)
    throw e
  } 
  try {
    ranMigrations = runMigrations(dbsToExps, productionDBs)
  } catch (e) {
    console.error(`Unable to run database migrations`)
    throw e
  }
  return ranMigrations
}

const updateECS = async () => { //FUBAR needs way of getting useIAM
  console.log(`Updating ECS services.`)

  let ECSName
  try {
    let config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'))
    ECSName = config.ECSName
  } catch (e) {
    console.error(`Unable to load pushkin.yaml`)
    throw e
  }

  const yamls = fs.readdirSync(path.join(process.cwd(), 'ECSTasks'));
  return Promise.all(
    yamls.forEach((yaml) => {
      if (yaml != "ecs-params.yml"){
        let composeCommand = `ecs-cli compose -f ${yaml} -p ${yaml.split('.')[0]} service up --ecs-profile ${useIAM} --cluster-config ${ECSName} --force-deployment`
        try {
         temp = exec(composeCommand, { cwd: path.join(process.cwd(), "ECStasks")})
        } catch(e) {
          console.warn('\x1b[31m%s\x1b[0m', `Unable to update service ${yaml}.`)
          console.warn('\x1b[31m%s\x1b[0m', e)
        }          
      }
    })
  )
}

const handleAWSUpdate = async () => {

  console.log(`Loading deployment config`)

  let publishedToDocker
  try {
    publishedToDocker = updateDocker();
  } catch(e) {
    throw e
  }

  let syncMe
  try {
    syncMe = updateS3()
  } catch(e) {
    throw e
  }

  let ranMigrations
  try {
    ranMigrations = updateMigrations()
  } catch (e) {
    throw e
  }    

  await Promise.all([ publishedToDocker, syncMe, ranMigrations ]) 
  //Technically only publishedToDocker needs to finish before we update ECS
  //But waiting for everything increases that likelihood

 let compose
  try {
    compose = updateECS()
  } catch (e) {
    throw e
  }

  return compose // this is a promise, so can be awaited
}


const handleCreateAutoScale = async () => {
  let projName
  try {
    let temp = loadConfig(path.join(process.cwd(), 'pushkin.yaml'))  
    projName = temp.info.projName.replace(/[^A-Za-z0-9]/g, "")
  } catch (e) {
    console.error(`Unable to find project name`)
    throw e
  }

  let useIAM
  try {
    useIAM = await inquirer.prompt([{ type: 'input', name: 'iam', message: 'Provide your AWS profile username that you want to use for managing this project.'}])
  } catch (e) {
    console.error('Problem getting AWS IAM username.\n', e)
    throw e
  }

  return createAutoScale(useIAM.iam, projName)
}

const handleViewConfig = async (what) => {
  moveToProjectRoot();
  let x = await ((what=='site' | !what) ? loadConfig(path.join(process.cwd(), 'pushkin.yaml')) : '')
  let exps = fs.readdirSync(path.join(process.cwd(), 'experiments'));
  let y = await Promise.all(exps.map(async (exp) => {
    return await (what == exp | !what) ? loadConfig(path.join(process.cwd(), 'experiments', exp, 'config.yaml')) : '';
  }));
  //Thanks to https://stackoverflow.com/questions/49627044/javascript-how-to-await-multiple-promises
}

const handleUpdateDB = async (verbose) => {
  if (verbose) console.log('--verbose flag set inside handleUpdateDB()');
  moveToProjectRoot();
  let settingUpDB, config;
  try {
     config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'));
  } catch (err) {
    console.log('Could not load pushkin.yaml');
    throw err;
  }

  try {
    settingUpDB = await setupdb(config.databases, path.join(process.cwd(), config.experimentsDir), verbose);
  } catch (err) {
    console.error(err);
    process.exit();
  }
  return settingUpDB;
}

// For removing any .DS_Store files if present.
const removeDS = (verbose) => {
  if (verbose) {
    console.log('--verbose flag set inside removeDS()');
    console.log('Removing any .DS_Store files, if present.');
  }
  shell.rm('-rf', '*/.DS_Store');
  shell.rm('-rf', './.DS_Store');
}

const handlePrep = async (verbose) => {
  if (verbose) console.log('--verbose flag set inside handlePrep()');
  moveToProjectRoot();
  const config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'));
  let out;
  if (verbose) {
    console.log(path.join(process.cwd(), config.experimentsDir));
    console.log(path.join(process.cwd(), config.coreDir));
  }
  try {
    out = await prep(
      path.join(process.cwd(), config.experimentsDir),
      path.join(process.cwd(), config.coreDir),
      verbose
    );
  } catch (err) {
    console.error(err);
    process.exit();
  }
  return;  
}

const handleAWSList = async () => {
  let useIAM
  try {
    useIAM = await inquirer.prompt([{ type: 'input', name: 'iam', message: 'Provide your AWS profile username that you want to use for managing this project.'}])
  } catch (e) {
    console.error('Problem getting AWS IAM username.\n', e)
    process.exit()
  }
  return awsList(useIAM.iam)
}

const handleAWSKill = async () => {
  let nukeMe
  try {
    nukeMe = await inquirer.prompt([{ type: 'input', name: 'kill', message: `This command will DELETE your website.\n This cannot be undone.\n Are you SURE you want to do this?\n Confirm by typing 'kill my website'.`}])
  } catch (e) {
    console.error('Problem getting permission.\n', e)
    process.exit()
  }
  if (nukeMe.kill != 'kill my website') {
    console.log('That is probably wise. Exiting.')
    return
  }
  let nukeMeTwice
  try {
    nukeMeTwice = await inquirer.prompt([{ type: 'input', name: 'kill', message: `Your database -- along with any data -- will be deleted.\n Confirm this is what you want by typing 'kill my data'.`}])
  } catch (e) {
    console.error('Problem getting permission.\n', e)
    process.exit()
  }
  if (nukeMeTwice.kill != 'kill my data') {
    console.log('That is probably wise. Exiting.')
    return
  }
  console.log(`I hope you know what you are doing. This makes me nervous every time...`)
  let useIAM
  try {
    useIAM = await inquirer.prompt([{ type: 'input', name: 'iam', message: 'Provide your AWS profile username that you want to use for managing this project.'}])
  } catch (e) {
    console.error('Problem getting AWS IAM username.\n', e)
    process.exit()
  }
  return awsArmageddon(useIAM.iam, 'kill')
}


const handleAWSArmageddon = async () => {
  let nukeMe
  try {
    nukeMe = await inquirer.prompt([{ type: 'input', name: 'armageddon', message: `This command will delete more or less EVERYTHING on your AWS account.\n This cannot be undone.\n Are you SURE you want to do this?\n Confirm by typing 'armageddon'.`}])
  } catch (e) {
    console.error('Problem getting permission.\n', e)
    process.exit()
  }
  if (nukeMe.armageddon != 'armageddon') {
    console.log('That is probably wise. Exiting.')
    return
  }
  let nukeMeTwice
  try {
    nukeMeTwice = await inquirer.prompt([{ type: 'input', name: 'armageddon', message: `Your database -- along with any data -- will be deleted.\n Confirm this is what you want by typing 'nuke my data'.`}])
  } catch (e) {
    console.error('Problem getting permission.\n', e)
    process.exit()
  }
  if (nukeMeTwice.armageddon != 'nuke my data') {
    console.log('That is probably wise. Exiting.')
    return
  }
  console.log(`I hope you know what you are doing. This makes me nervous every time...`)
  let useIAM
  try {
    useIAM = await inquirer.prompt([{ type: 'input', name: 'iam', message: 'Provide your AWS profile username that you want to use for managing this project.'}])
  } catch (e) {
    console.error('Problem getting AWS IAM username.\n', e)
    process.exit()
  }
  return awsArmageddon(useIAM.iam, 'armageddon')
}

const getVersions = async (url) => {
  //Function: getVersions()
   //Retrieves URLs for versions of site and experiment templates.
   //Parameters:
   // url - a GitHub API URL to the releases of a site or experiment template repo
   //Returns:
   // verList - an object with keys as version names and values as GitHub API URLs for each version
  let response
  let body
  let verList = {}
  try {
    const response = await got(url);
    body = JSON.parse(response.body)
    body.forEach((r) => { // Loop through the objects corresponding to each version
      verList[r.tag_name] = r.url; // Fill out verList object with GitHub API URLs for each version
    })
  } catch (error) {
    console.error('Problem parsing github JSON');
    throw error;
  }
  return verList
}

const handleInstall = async (what, verbose) => {
  try {
    if (verbose) console.log('--verbose flag set inside handleInstall()');
    if (what == 'site') {
      const siteList = await listSiteTemplates();
      inquirer.prompt([
          { type: 'list', name: 'sites', choices: Object.keys(siteList).concat("path","url"), default: 0, message: 'Which site template do you want to use?'}
        ]).then(answers => {
          let siteType = answers.sites
          if (siteType == "path") {
            inquirer.prompt(
              [{ type: 'input', name: 'path', message: 'What is the absolute path to your site template?'}]
            ).then(async (answers) => {
              await copyPushkinSite(process.cwd(), answers.path, verbose)
              if (verbose) console.log("setting up transactions db");
              await setupTestTransactionsDB(verbose) //Not distributed with sites since it's the same for all of them.
            })
          }else if (siteType == "url") {
            inquirer.prompt(
              [{ type: 'input', name: 'url', message: 'What is the url for your site template (this should begin with "https://" and end with "releases", but either api.github.com or github.com URLs are accepted)?'}]
            ).then((answers) => {
              let templateURL = answers.url
              // Check whether URL is for GitHub API and, if not, convert it so it works with getPushkinSite()
              if (templateURL.startsWith('https://github.com')) {
                templateURL = templateURL.replace('github.com', 'api.github.com/repos')
              }
              // Check URL to make sure it doesn't end with slash, since that will mess up GitHub API URLs
              if (templateURL.endsWith('/')) {
                templateURL = templateURL.slice(0,-1) // Remove the last character (i.e. '/')
              }
              getVersions(templateURL)
              .then((verList) => {
                inquirer.prompt(
                  [{ type: 'list', name: 'version', choices: Object.keys(verList), default: 0, message: 'Which version?'}]
                ).then(async (answers) => {
                  await getPushkinSite(process.cwd(), verList[answers.version], verbose)
                  if (verbose) console.log("setting up transactions db");
                  await setupTestTransactionsDB(verbose) //Not distributed with sites since it's the same for all of them.
                })
              })
            })
          }else{
            getVersions(siteList[siteType])
            .then((verList) => {
              inquirer.prompt(
                [{ type: 'list', name: 'version', choices: Object.keys(verList), default: 0, message: 'Which version? (Recommend:'.concat(Object.keys(verList)[0]).concat(')')}]
              ).then(async (answers) => {
                await getPushkinSite(process.cwd(), verList[answers.version], verbose)
                if (verbose) console.log("setting up transactions db");
                await setupTestTransactionsDB(verbose) //Not distributed with sites since it's the same for all of them.
              })
            })
          }
        })
    } else {
      //definitely experiment then
      moveToProjectRoot()
      inquirer.prompt(
        [{ type: 'input', name: 'name', message: 'What do you want to call your experiment?'}]
      ).then(async (answers) => {
        const longName = answers.name
        const shortName = longName.replace(/[^\w\s]/g, "").replace(/ /g,"_");
        let config = await loadConfig('pushkin.yaml');
        const expList = await listExpTemplates();
        inquirer.prompt(
          [{ type: 'list', name: 'experiments', choices: Object.keys(expList).concat("path","url"), default: 0, message: 'Which experiment template do you want to use?'}]
        ).then(answers => {
          let expType = answers.experiments
          if (expType == "path") {
            inquirer.prompt(
              [{ type: 'input', name: 'path', message: 'What is the absolute path to your experiment template?'}]
            ).then(async (answers) => {
              await copyExpTemplate(path.join(process.cwd(), config.experimentsDir), answers.path, longName, shortName, process.cwd(), verbose)
            })
          } else if (expType == "url") {
            inquirer.prompt(
              [{ type: 'input', name: 'url', message: 'What is the url for your experiment template (this should begin with "https://" and end with "releases", but either api.github.com or github.com URLs are accepted)?'}]
            ).then((answers) => {
              let templateURL = answers.url
              // Check whether URL is for GitHub API and, if not, convert it so it works with getPushkinSite()
              if (templateURL.startsWith('https://github.com')) {
                templateURL = templateURL.replace('github.com', 'api.github.com/repos')
              }
              // Check URL to make sure it doesn't end with slash, since that will mess up GitHub API URLs
              if (templateURL.endsWith('/')) {
                templateURL = templateURL.slice(0,-1) // Remove the last character (i.e. '/')
              }
              getVersions(templateURL)
              .then((verList) => {
                inquirer.prompt(
                  [{ type: 'list', name: 'version', choices: Object.keys(verList), default: 0, message: 'Which version?'}]
                ).then(async (answers) => {
                  let ver = answers.version
                  const url = verList[ver]
                  await getExpTemplate(path.join(process.cwd(), config.experimentsDir), url, longName, shortName, process.cwd(), verbose)
                })
              })
            })
          }else{
            getVersions(expList[expType])
            .then((verList) => {
              inquirer.prompt(
                [{ type: 'list', name: 'version', choices: Object.keys(verList), default: 0, message: 'Which version? (Recommend:'.concat(Object.keys(verList)[0]).concat(')')}]
              ).then(async (answers) => {
                let ver = answers.version;
                const url = verList[ver];
                let newExpJs; // Only used if they want to import a jsPsych experiment
                // If they're using the basic template 5+, ask about importing a jsPsych experiment
                if (expType === 'basic' && ver.search(/v[5-9]/) === 0) {
                  await inquirer.prompt(
                    [{ type: 'confirm', name: 'expHtmlBool', default: false, message: 'Would you like to import a jsPsych experiment.html?'}]
                  ).then(async (answers) => {
                    if (answers.expHtmlBool) {
                      await inquirer.prompt(
                        [{ type: 'input', name: 'expHtmlPath', message: 'What is the absolute path to your experiment.html?'}]
                      ).then((answers) => {
                        if (!answers.expHtmlPath) {
                          console.log('No path provided to jsPsych experiment; installing the basic template as is.');
                        } else if (!fs.existsSync(answers.expHtmlPath)) {
                          console.log('Path to jsPsych experiment does not exist; installing the basic template as is.');
                        } else if (!fs.lstatSync(answers.expHtmlPath).isFile()) {
                          console.log('Invalid file path; installing the basic template as is.');
                        } else {
                          let expHtmlPlugins = getJsPsychPlugins(answers.expHtmlPath, verbose);
                          // If you wanted to add a feature to ask the user if there are additional plugins they want,
                          // here would probably be the place to implement it.
                          let expHtmlImports = getJsPsychImports(expHtmlPlugins, verbose);
                          let expHtmlTimeline = getJsPsychTimeline(answers.expHtmlPath, verbose);
                          if (expHtmlImports && expHtmlTimeline) {
                            // Create the necessary import statements from the object of jsPsych plugins
                            let imports = '';
                            Object.keys(expHtmlImports).forEach((plugin) => {
                              // Check if plugin specifies version (is there another "@" after initial one?)
                              if (plugin.slice(1).includes('@')) {
                                let pluginNoVersion = '@' + plugin.split('@')[1] // [1] will be the plugin name, add back leading '@'
                                let pluginVersion = plugin.split('@')[2] // [2] will be the version number
                                // Add version info as a comment after the import statement (to be read by prep later)
                                imports = imports.concat(`import ${expHtmlImports[plugin]} from '${pluginNoVersion}'; // version:${pluginVersion} //\n`);
                              } else {
                                imports = imports.concat(`import ${expHtmlImports[plugin]} from '${plugin}';\n`);
                              }
                            });
                            newExpJs = `${imports}\nexport function createTimeline(jsPsych) {\n${expHtmlTimeline}\nreturn timeline;\n}\n`;
                          } else {
                            console.log(`Problem importing experiment.html; installing the basic template as is.`);
                          }
                        }
                      })
                    }
                  })
                }
                await getExpTemplate(path.join(process.cwd(), config.experimentsDir), url, longName, shortName, process.cwd(), verbose);
                if (newExpJs) {
                  if (verbose) console.log(`Writing new experiment.js file`);
                  fs.writeFileSync(path.join(process.cwd(), config.experimentsDir, shortName, 'web page/src/experiment.js'), newExpJs);
                }
              })
            })
          }
        })
      })
    }
  } catch(e) {
    throw e
  }
}

const inquirerPromise = async (type, name, message) => {
  let answers = inquirer.prompt([ { type: 'input', name: 'name', message: 'Name your project'}])
  return answers[name]
}

const handleAWSInit = async (force) => {

 let DHID
 try {
   DHID = await dockerLogin(); 
 } catch (error) {
   console.log(error);
   process.exit();
 }

 let config
  try {
    config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'))
  } catch (e) {
    console.error(`Unable to load pushkin.yaml`)
    throw e
  }

  let projName, useIAM, awsName, stdOut

  try {
    execSync('aws --version')
  } catch(e) {
    console.error('Please install the AWS CLI before continuing.')
    process.exit();
  }

  let newProj = true
  if (config.info.projName) {
    let myChoices = (config.info.projName ? [config.info.projName, 'new'] : ['new'])
    try {
      projName = await inquirer.prompt([ { type: 'list', name: 'name', choices: myChoices, message: 'Which project?'}])
    } catch (e) {
      throw e
    }
    if (projName.name != "new") {
      newProj = false;
      awsName = config.info.awsName
    }
    if (force) {
      try {
        //Run this anyway to reset awsResources.js and remove productionDBs from pushkin.yaml
        awsName = await nameProject(projName.name)
      } catch (e) {
        throw e
      }
    }
  }

  if (newProj) {
    try {
      projName = await inquirer.prompt([ { type: 'input', name: 'name', message: 'Name your project'}])
    } catch(e) {
      console.error(e)
      process.exit()
    }
    try {
        awsName = await nameProject(projName.name)    
    } catch (e) {
      throw e
    }
  }


  try {
    useIAM = await inquirer.prompt([{ type: 'input', name: 'iam', message: 'Provide your AWS profile username that you want to use for managing this project.'}])
  } catch (e) {
    console.error('Problem getting AWS IAM username.\n', e)
    process.exit()
  }
  try {
    stdOut = execSync(`aws configure list --profile ${useIAM.iam}`).toString()
  } catch (e) {
    console.error(`The IAM user ${useIAM.iam} is not configured on the AWS CLI. For more information see https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html`)
    process.exit();
  }
  let addedIAM
  try {
    addedIAM = addIAM(useIAM.iam) //this doesn't need to be synchronous      
  } catch(e) {
    console.error(e)
    process.exit()
  }
  try {
    await Promise.all([awsInit(projName.name, awsName, useIAM.iam, config.DockerHubID), addedIAM])
  } catch(e) {
    throw e
  }
  console.log("finished aws init")

  return
}

const killLocal = async () => {
  console.log('Removing all containers and volumes, as well as pushkin images. To additionally remove third-party images, run `pushkin armageddon`.') 
  moveToProjectRoot();
  try {
    await compose.stop({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml'})
  } catch (err) {
    console.error('Problem with stopping docker: ', err)
    process.exit();
  }
  try {
    await compose.rm({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml'})
  } catch (err) {
    console.error('Problem with removing docker containers: ', err)
    process.exit();
  }
  try {
    await exec(`docker volume rm pushkin_test_db_volume pushkin_message_queue_volume; docker images -a | grep "_worker" | awk '{print $3}' | xargs docker rmi -f`)    
    await exec(`docker rmi -f api`)
    await exec(`docker rmi -f server`)
  } catch (err) {
    console.error('Problem with removing volumes and images docker: ', err)
    process.exit();
  }
  console.log('Completed kill')
  return;  
}

async function main() {
//  program
//    .option('-d, --debug', 'output extra debugging')
//    .option('-s, --small', 'small pizza size')
//    .option('-p, --pizza-type <type>', 'flavour of pizza');

  program
    .command('install <what>')
    .option('-v, --verbose', 'output extra debugging info')
    .description(`Install template website ('site') or experiment ('experiment').`)
    .action((what, options) => {
      if (what == 'site' | what == 'experiment'){
        try {
          handleInstall(what, options.verbose)
        } catch(e) {
          console.error(e)
          process.exit()
        }
      }else{
        console.error(`Command not recognized. Run 'pushkin --help' for help.`)
      }
    });

  program
    .command('aws <cmd>')
    .description(`For working with AWS. Commands include:\n 
      init: initialize an AWS deployment.\n 
      update: update an AWS deployment.\n
      armageddon: delete AWS resources created by Pushkin.\n
      list: list AWS resources created by Pushkin (and possibly others).`)
    .option('-f, --force', 'Applies only to init. Resets installation options. Does not delete AWS resources (for that, use aws armageddon).', false)
    .option('-v, --verbose', 'output extra debugging info')
    .action(async (cmd, options) => {
      moveToProjectRoot();
      switch (cmd){
        case 'init':
          try {
            setEnv(false, options.verbose) //asynchronous
            await handleAWSInit(options.force);
          } catch(e) {
            console.error(e)
            process.exit();
          }
          break;
        case 'update':
          try {
            //await handleAWSUpdate();
            console.warn('\x1b[31m%s\x1b[0m', `Not currently implemented. Sorry.`)
          } catch(e) {
            console.error(e);
            process.exit();
          }
          break;
        case 'armageddon':
          try {
            await handleAWSArmageddon();
          } catch(e) {
            console.error(e);
            process.exit();
          }
          break;
        case 'list':
          try {
            await handleAWSList();
          } catch(e) {
            console.error(e);
            process.exit();
          }
          break;
        default: 
          console.error("Command not recognized. For help, run 'pushkin help aws'.")
      }
    });

  program
    .command('setDockerHub')
    .description(`Set (or change) your DockerHub ID. This must be run before deploying to AWS.`)
    .action(() => {
      moveToProjectRoot();
      inquirer.prompt([
          { type: 'input', name: 'ID', message: 'What is your DockerHub ID?'}
        ]).then(async (answers) => {
          let config
          try {
            config = await loadConfig(path.join(process.cwd(), 'pushkin.yaml'));
          } catch(e) {
            console.error(e)
            process.exit();
          }
          config.DockerHubID = answers.ID;
          try {
            fs.writeFileSync(path.join(process.cwd(), 'pushkin.yaml'), jsYaml.safeDump(config))
          } catch (e) {
            console.error('Unable to rewrite pushkin.yaml.')
            console.error(e)
            process.exit()
          }
          inquirer.prompt([
            { type: 'input', name: 'pw', message: 'What is your DockerHub password?'}
          ]).then(async (answers) => {
            fs.writeFileSync('.docker', answers.pw, err => {
              if (err) {
                console.error(err);
              }
              // file written successfully
            });
          })
        })
    })

  program
    .command('prep')
    .description('Prepares local copy for local testing. This step includes running migrations, so be sure you have read the documentation on how that works.')
    .option('-nm, --nomigrations', 'Do not run migrations. Be sure database structure has not changed!')
    .option('-v, --verbose', 'output extra debugging info')
    .action(async (options) => {
      let awaits;
      removeDS(options.verbose);
      try {
        if (options.nomigrations) {
          //only running prep
          awaits = [handlePrep(options.verbose)];
        } else {
          //running prep and updated DB
          awaits = [handlePrep(options.verbose), handleUpdateDB(options.verbose)];
        }
      } catch (e) {
        console.error(e);
        process.exit();
      }
      return await Promise.all(awaits);
    })

  program
    .command('start')
    .description('Starts local deploy for debugging purposes. To start only the front end (no databases), see the manual.')
    .option('-nc, --nocache', 'Rebuild all images from scratch, without using the cache.')
    .option('-v, --verbose', 'output extra debugging info')
    .action(async (options) => {
      if (options.verbose) console.log("starting start...");
      moveToProjectRoot();
      if (options.verbose) console.log(`Setting front-end 'environment variable'`);
      try {
        setEnv(true, options.verbose) //this is synchronous
      } catch (e) {
        console.error(`Unable to update .env.js`)
      }
      if (options.verbose) console.log(`Copying experiments.js to front-end.`);
      try {
        fs.copyFileSync('pushkin/front-end/src/experiments.js', 'pushkin/front-end/experiments.js');
      } catch (e) {
        console.error("Couldn't copy experiments.js. Make sure it exists and is in the right place.")
        process.exit();
      }
      if (options.nocache){
        try {
          await compose.buildAll({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml', log: options.verbose, commandOptions: ["--no-cache"]})    
        } catch (e) {
          console.error("Problem rebuilding docker images");
          throw e;
        }
        if (options.verbose) console.log(`Running docker-compose up...`);
        compose.upAll({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml', log: options.verbose, commandOptions: ["--remove-orphans"]})
          .then(
            out => { 
              console.log(out.out, 'Starting. You may not be able to load localhost for a minute or two.')
            },
            err => { console.log('something went wrong:', err)}
          );
      } else {
        compose.upAll({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml', log: options.verbose, commandOptions: ["--build","--remove-orphans"]})
          .then(
            out => { console.log(out.out, 'Starting. You may not be able to load localhost for a minute or two.')},
            err => { console.log('something went wrong:', err)}
          );
      }
      return;
    })

  program
    .command('stop')
    .description('Stops the local deploy. This will not remove the local docker images. To do that, see documentation for pushkin kill and pushkin armageddon.')
    .action(() => {
      moveToProjectRoot();
      compose.stop({cwd: path.join(process.cwd(), 'pushkin'), config: 'docker-compose.dev.yml'})
        .then(
          out => { console.log(out.out, 'done')},
          err => { console.log('something went wrong:', err)}
        );
      return;
    })

  program
    .command('kill')
    .description('Removes all containers and volumes from local Docker, as well as pushkin-specific images. To additionally remove third-party images, run `pushkin armageddon`.')
    .action(killLocal)

  program
    .command('armageddon')
    .description('Complete reset of the local docker. This will generate some error messages, which you can safely ignore. WARNING This will NOT discriminate between Pushkin-related Docker images and other Docker images you may be using.')
    .action(async () => {
      console.log(`Deleting all local docker images, including those not related to Pushkin...`)
      try {
        await exec('docker stop $(docker ps -aq); docker rm $(docker ps -aq); docker network prune -f; docker rmi -f $(docker images --filter dangling=true -qa); docker volume rm $(docker volume ls --filter dangling=true -q); docker rmi -f $(docker images -qa)')
      } catch (err) {
        console.err(err);
      }
      console.log(`Now running docker system prune. This will take a while...`)
      try {
        await exec('docker system prune -af)')
      } catch (err) {
        console.err(err);
      }
     return;
    })

  program
    .command('config [what]')
    .description('View config file for `what`, with possible values being `site` or any of the installed experiments by name. Defaults to all.')
    .action((what) => {
      handleViewConfig(what)
    });


  program
    .command('utils <cmd>')
    .description(`Functions that are useful for backwards compatibility or debugging.\n
      updateDB: Updates test database. This is automatically run as part of 'pushkin prep'.\n
      setup-transaction-db: Creates a local transactions db. Useful for users of old site templates who wish to use CLI v2+.\n
      aws-auto-scale: Setups up default autoscaling for an AWS deploy. Normally run as part of 'aws init'.\n
      zip: Useful for publishing new templates. Zips up current directory, recursively ignoring .git and node_modules.`)
    .action(async (cmd) => {
      switch (cmd){
        case 'updateDB':
          moveToProjectRoot();
          try {
            await handleUpdateDB();
          } catch(e) {
            console.error(e)
            process.exit();
          }
          break;
        case 'setup-transaction-db':
          moveToProjectRoot();
          try {
            await setupTestTransactionsDB();
          } catch(e) {
            console.error(e);
            process.exit();
          }
          break;
          case 'zip':
            try {
              execSync(`zip -r Archive.zip . -x "*node_modules*" -x "*.git*" -x "*.DS_Store"`);
            } catch(e) {
              console.error(e);
              process.exit();
            }
            break;
          case 'aws-auto-scale':
            moveToProjectRoot();
            try {
            await handleCreateAutoScale();
          } catch(e) {
            console.error(e);
            process.exit();
          }
          break;
        default: 
          console.error("Command not recognized. For help, run 'pushkin help utils'.")
      }
    });

   program.parseAsync(process.argv);
}

main();
 
//program.parseAsync(process.argv);
