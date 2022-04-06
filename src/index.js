'use strict';

// Setup log writing
require('@serverless/utils/log-reporters/node');

const path = require('path');
const args = require('minimist')(process.argv.slice(2));
const traverse = require('traverse');
const { clone } = require('ramda');
const utils = require('./utils');
const renderHelp = require('./render-help');
const Context = require('./Context');
const Component = require('./Component');
const ComponentsService = require('./ComponentsService');
const generateTelemetryPayload = require('./utils/telemetry/generate-payload');
const storeTelemetryLocally = require('./utils/telemetry/store-locally');
const sendTelemetry = require('./utils/telemetry/send');
const ServerlessError = require('./serverless-error');
const handleError = require('./handle-error');
const colors = require('./cli/colors');

let options;
let method;
let configurationForTelemetry;
let componentName;
let context;

process.once('uncaughtException', (error) => {
  // Refactor it to not rely heavily on context because it is only needed for logs
  const usedContext = context || new Context({ root: process.cwd() });
  storeTelemetryLocally(
    {
      ...generateTelemetryPayload({
        configuration: configurationForTelemetry,
        options,
        command: method,
        componentName,
        error,
        context: usedContext,
      }),
    },
    usedContext
  );
  handleError(error, context.logger);
  sendTelemetry(usedContext).then(() => process.exit(1));
});

require('signal-exit/signals').forEach((signal) => {
  process.once(signal, () => {
    // If there's another listener (e.g. we're in deamon context or reading stdin input)
    // then let the other listener decide how process will exit
    const isOtherSigintListener = Boolean(process.listenerCount(signal));
    // Refactor it to not rely heavily on context because it is only needed for logs
    const usedContext = context || new Context({ root: process.cwd() });
    storeTelemetryLocally(
      {
        ...generateTelemetryPayload({
          configuration: configurationForTelemetry,
          options,
          command: method,
          componentName,
          context: usedContext,
          interruptSignal: signal,
        }),
      },
      usedContext
    );
    if (isOtherSigintListener) return;
    // Follow recommendation from signal-exit:
    // https://github.com/tapjs/signal-exit/blob/654117d6c9035ff6a805db4d4acf1f0c820fcb21/index.js#L97-L98
    if (process.platform === 'win32' && signal === 'SIGHUP') signal = 'SIGINT';
    process.kill(process.pid, signal);
  });
});

// Simplified support only for yml
const getServerlessFile = (dir) => {
  const ymlFilePath = path.join(dir, 'serverless-compose.yml');
  const yamlFilePath = path.join(dir, 'serverless-compose.yaml');

  if (utils.fileExistsSync(ymlFilePath)) {
    return utils.readFileSync(ymlFilePath);
  }
  if (utils.fileExistsSync(yamlFilePath)) {
    return utils.readFileSync(yamlFilePath);
  }

  return false;
};

const isComponentsTemplate = (serverlessFile) => {
  if (typeof serverlessFile !== 'object') {
    return false;
  }

  // make sure it's NOT a framework file
  if (serverlessFile.provider && serverlessFile.provider.name) {
    return false;
  }

  // make sure it IS a serverless-compose file
  if (serverlessFile.services) {
    return true;
  }

  return false;
};

const getConfiguration = async (template) => {
  if (typeof template === 'string') {
    if (
      (!utils.isJsonPath(template) && !utils.isYamlPath(template)) ||
      !(await utils.fileExists(template))
    ) {
      throw new ServerlessError(
        'The referenced template path does not exist',
        'REFERENCED_TEMPLATE_PATH_DOES_NOT_EXIST'
      );
    }

    return utils.readFile(template);
  } else if (typeof template !== 'object') {
    throw new ServerlessError(
      'The template input could either be an object, or a string path to a template file',
      'INVALID_TEMPLATE_FORMAT'
    );
  }
  return template;
};

// For now, only supported variables are `${sls:stage}` and `${env:<key>}`;
// TODO: After merging into Framework CLI, unify the configuration resolution handling with Framework logic
const resolveConfigurationVariables = async (
  configuration,
  stage,
  unrecognizedVariableSources = new Set()
) => {
  const regex = /\${(\w*:[\w\d.-]+)}/g;
  const slsStageRegex = /\${sls:stage}/g;
  const envRegex = /\${env:(\w*[\w.-_]+)}/g;

  let variableResolved = false;
  const resolvedConfiguration = traverse(configuration).forEach(function (value) {
    const matches = typeof value === 'string' ? value.match(regex) : null;
    if (matches) {
      let newValue = value;
      for (const match of matches) {
        if (slsStageRegex.test(match)) {
          variableResolved = true;
          newValue = newValue.replace(match, stage);
        } else if (envRegex.test(match)) {
          const referencedPropertyPath = match.substring(2, match.length - 1).split(':');
          if (process.env[referencedPropertyPath[1]] == null) {
            throw new ServerlessError(
              `The environment variable "${referencedPropertyPath[1]}" is referenced but is not defined`,
              'CANNOT_FIND_ENVIRONMENT_VARIABLE'
            );
          }
          if (match === value) {
            newValue = process.env[referencedPropertyPath[1]];
          } else {
            newValue = value.replace(match, process.env[referencedPropertyPath[1]]);
          }
          variableResolved = true;
        } else {
          const variableSource = match.slice(2).split(':')[0];
          unrecognizedVariableSources.add(variableSource);
        }
      }
      this.update(newValue);
    }
  });
  if (variableResolved) {
    return resolveConfigurationVariables(resolvedConfiguration, stage, unrecognizedVariableSources);
  }
  if (unrecognizedVariableSources.size) {
    throw new ServerlessError(
      `Unrecognized configuration variable sources: "${Array.from(unrecognizedVariableSources).join(
        '", "'
      )}"`,
      'UNRECOGNIZED_VARIABLE_SOURCES'
    );
  }
  return resolvedConfiguration;
};

const runComponents = async () => {
  if (args.help || args._[0] === 'help') {
    await renderHelp();
    return;
  }

  method = args._;
  if (!method) {
    await renderHelp();
    return;
  }
  method = method.join(':');
  options = args;

  if (options.service) {
    componentName = options.service;
    delete options.service;
  } else if (method.includes(':')) {
    let methods;
    [componentName, ...methods] = method.split(':');
    method = methods.join(':');
  }
  delete options._; // remove the method name if any

  const serverlessFile = getServerlessFile(process.cwd());

  if (!serverlessFile) {
    throw new ServerlessError(
      'No serverless-compose.yml file found',
      'CONFIGURATION_FILE_NOT_FOUND'
    );
  }

  if (!isComponentsTemplate(serverlessFile)) {
    throw new ServerlessError(
      'serverless-compose.yml does not contain valid Serverless Compose configuration.\nRead about Serverless Compose in the documentation: https://github.com/serverless/compose',
      'INVALID_CONFIGURATION'
    );
  }

  const contextConfig = {
    root: process.cwd(),
    stateRoot: path.join(process.cwd(), '.serverless'),
    verbose: options.verbose,
    stage: options.stage || 'dev',
    appName: serverlessFile.name,
  };

  context = new Context(contextConfig);
  await context.init();
  const configuration = await getConfiguration(serverlessFile);
  await resolveConfigurationVariables(configuration, context.stage);

  // For telemetry we want to keep the configuration that has references to components outputs unresolved
  // So we can properly count it
  configurationForTelemetry = clone(configuration);

  // Catch early Framework CLI-wide options that aren't supported here
  // Since these are reserved options, we don't even want component-specific commands to support them
  // so we detect these early for _all_ commands.
  const unsupportedGlobalCliOptions = ['debug', 'config', 'param'];
  unsupportedGlobalCliOptions.forEach((option) => {
    if (options[option]) {
      throw new ServerlessError(
        `The "--${option}" option is not supported (yet) in Serverless Compose`,
        'INVALID_CLI_OPTION'
      );
    }
  });

  try {
    const componentsService = new ComponentsService(context, configuration);
    await componentsService.init();

    if (componentName) {
      await componentsService.invokeComponentCommand(componentName, method, options);
    } else {
      await componentsService.invokeGlobalCommand(method, options);
    }

    storeTelemetryLocally(
      {
        ...generateTelemetryPayload({
          configuration: configurationForTelemetry,
          options,
          command: method,
          componentName,
          context,
        }),
      },
      context
    );
    await sendTelemetry(context);
    context.shutdown();

    // If at least one of the internal commands failed, we want to exit with error code 1
    if (Object.values(context.componentCommandsOutcomes).includes('failure')) {
      context.logger.log();
      context.logger.log(
        colors.darkGray('Verbose logs are available in ".serverless/compose.log"')
      );
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (e) {
    handleError(e, context.logger);
    storeTelemetryLocally(
      {
        ...generateTelemetryPayload({
          configuration: configurationForTelemetry,
          options,
          command: method,
          componentName,
          context,
          error: e,
        }),
      },
      context
    );
    await sendTelemetry(context);
    process.exit(1);
  }
};

module.exports = {
  runComponents,
  Component,
  Context,
};
