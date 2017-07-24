import _ from 'lodash';
import Bot from './bot';
import logger from 'winston';
import { ConfigurationError } from './errors';
logger.level = 'debug';

/**
 * Reads from the provided config file and returns an array of bots
 * @return {object[]}
 */
export function createBots(configFile) {
  const bots = [];

  // The config file can be both an array and an object
  if (Array.isArray(configFile)) {
    configFile.forEach((config) => {
      const bot = new Bot(config);
      bot.connect();
      bots.push(bot);
    });
  } else if (_.isObject(configFile)) {
    const bot = new Bot(configFile);
    bot.connect();
    bots.push(bot);
  } else {
    throw new ConfigurationError();
  }

  return bots;
}

/**
 * Returns occurances of a current channel member's name with `@${name}`
 * @return {string}
 */
export function highlightUsername(user, text) {
  const words = text.split(' ');
  const userRegExp = new RegExp(`^${user}[,.:!?]?$`);

  return words.map(word => {
    // if the user is already prefixed by @, don't replace
    if (word.indexOf(`@${user}`) === 0) {
      return word;
    }

    // username match (with some chars)
    if (userRegExp.test(word)) {
      return `@${word}`;
    }

    return word;
  }).join(' ');
}

export function onlineIRCUsers(message, query) {
  const ircChannel = this.getIRCChannel(message.channel);
  if (ircChannel == null) return;
  logger.debug(`Getting online users for IRC channel ${ircChannel}`);

  this.ircClient.once('names', (chan, names) => {
    const userNames = _.keys(names);
    if (query == null) {
      // Send list of all users directly to user on .online
      // Open IM in case there isn't already an ongoing DM between the bot and the user
      this.slack.web.im.open(message.user, (response, data) => {
        userNames.sort();
        const reply = `The following users are in ${ircChannel}: ${userNames.join(', ')}`;
        this.slack.rtm.sendMessage(reply, data.channel.id);
      });
    } else {
      const matched = [];
      for (const name of userNames) {
        if (name.match(RegExp(query,  'i')) !== null) {
          matched.push(name);
        }
      }
      let reply = `No users are online matching '${query}'.`;
      if (matched.length > 0) {
        matched.sort();
        reply = `'${query}' matched the following users: ${matched.join(', ')}`;
      }
      this.slack.rtm.sendMessage(reply, message.channel);
    }
  });
  this.ircClient.send('NAMES', ircChannel);
}

/**
 * Retrieves the current IRC channel topic
 */
export function ircTopic(message) {
  const ircChannel = this.getIRCChannel(message.channel);
  if (ircChannel == null) return; 
  logger.debug(`Requesting topic for IRC channel ${ircChannel}`);

  this.ircClient.once('topic', (chan, topic) => {
    this.slack.rtm.sendMessage(`IRC Topic:  ${topic}`, message.channel);
  });
  this.ircClient.send('TOPIC', ircChannel);
}

export function setNewTopic(message, argument, data) {
    const ircChannel = this.getIRCChannel(message.channel);
    if (ircChannel == null) return;
    logger.debug(`Requesting topic for IRC channel ${ircChannel}`,`MESSAGE.CHANNEL: ${message.channel}, MESSAGE.USER: ${message.user}`);
    const newTopic =  argument.split(" ");

    this.ircClient.once('topic', (chan, topic) => {
      logger.debug(`Sending: ${topic}, ${message.channel}`)
      this.slack.authpost.channels.setTopic(message.channel, `${topic}`);
      this.slack.rtm.sendMessage(`IRC Topic:  ${topic}`, message.channel);
    });
   
    this.ircClient.send('TOPIC', ircChannel, `${argument} ${data}`);
}
/**
 * Sends the available commands in a DM to the requesting user
 */
export function commandHelp(message) {
  logger.debug('Sending help command response.');
  // Open IM in case there isn't already an ongoing DM between the bot and the user
  //this.slack.web.im.open(message.user, (response, data) => {
  
    const reply = '```.online [, query]``` ' +
      'Sends a list of all names in the IRC channel as a DM. ' +
      'If query parameter is provided, sends a list of partially matching nicks and displays ' +
      'them in the Slack channel.\n' +
      '```.irctopic``` ' +
      'Sends the IRC channel topic to the Slack channel.' +
      '```.topic [new topic]``` ' +
      'Sets the topic in the IRC Channel.' +
      '```.help``` ' +
      'Displays this message.';
    this.slack.rtm.sendMessage(`HELP: ${reply}`, message.channel);
}


/**
 * Sends a private message to the IRC user
 */
export function privMessage(message, ircUser, msg) {
  const { dataStore } = this.slack.rtm;
  logger.debug(message.channel);
  if (!message.channel.startsWith('D')) {
    // Warn user to use the bot DM
    // Open IM in case there isn't already an ongoing DM between the bot and the user
    this.slack.web.im.open(message.user, (response, data) => {
      const reply = 'The \`.msg\` command should be used through this DM only, ' +
          'using it in an open channel allows visibility to all in that channel. ' +
          'Your original message has not been sent to the user and you may want to delete it from the public channel.';
      this.slack.rtm.sendMessage(reply, data.channel.id);
    });
    return;
  }
  logger.debug(`Sending private message to ${ircUser}.`);
  const messageQueue = this.messageQueues[message.user];
  const user = dataStore.getUserById(message.user);

  this.ircClient.whois(ircUser, (resp) => {
    if (resp.host) {
      messageQueue[ircUser] = messageQueue[ircUser] || [];
      messageQueue[ircUser].push({ text: msg });
      this.sendMessagesToIRC(user);
    } else {
      this.slack.rtm.sendMessage(`\`${ircUser}\` is not online.`, message.channel);
    }
  });
}