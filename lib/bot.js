import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import gist from 'quick-gist';
import { AllHtmlEntities } from 'html-entities';
import { MemoryDataStore, RtmClient, WebClient, RTM_EVENTS, RTM_MESSAGE_SUBTYPES } from '@slack/client';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';
import { highlightUsername, commandHelp, ircTopic, onlineIRCUsers, setNewTopic } from './helpers';

const ALLOWED_SUBTYPES = ['me_message'];
const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];
const SLACK_REGEX = /@(\S+)/g;
const SERVER_NICKLEN = 16;
const CODE_REGEX = /```([^]*)```/;
/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });
    validateChannelMapping(options.channelMapping);
    const authpost = new WebClient(options.oath);
    const web = new WebClient(options.token);
    const rtm = new RtmClient(options.token, { dataStore: new MemoryDataStore() });
    this.slack = { web, rtm, authpost };

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.statusChanges = options.statusChanges || false;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.clientId = options.imgur;
    this.commandCharacters = options.commandCharacters || [];
    this.slackChannels = _.keys(options.channelMapping);
    this.ircChannels = _.values(options.channelMapping);    
    this.channels = _.values(options.channelMapping);
    this.muteSlackbot = options.muteSlackbot || false;
    this.nickSuffix = options.userNickSuffix || '-sl';
    this.disconnectOnAway = options.disconnectOnAway || false;
    this.ircTimeout = options.ircTimeout || 120; // Seconds
    this.ircNameList = null;  //options.nameList;
    this.nickRegex = new RegExp(`@?(\\S+${this.nickSuffix}\\d?)`, 'g');
    this.muteUsers = {
      slack: [],
      irc: [],
      ...options.muteUsers
    };

    const defaultUrl = 'http://api.adorable.io/avatars/48/$username.png';
    // Disable if it's set to false, override default with custom if available:
    this.avatarUrl = options.avatarUrl !== false && (options.avatarUrl || defaultUrl);
    this.slackUsernameFormat = options.slackUsernameFormat || '$username (IRC)';
    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, slackChan) => {
      this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
    }, this);

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Slack');
    this.slack.rtm.start();

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  startNamelist(ircChannel) {
    setInterval(() => {
      this.ircClient.send('NAMES', ircChannel);
    }, this.ircNameList.interval * 1000);
  }

  attachListeners() {
    this.slack.rtm.on('open', () => {
      logger.debug('Connected to Slack');
      for (const key of this.slackChannels) {
        this.checkActiveUsers(key);
      }
    });



    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.ircClient.on('abort', () => {
      logger.error('Maximum IRC retry count reached, exiting.');
      process.exit(1);
    });

    this.slack.rtm.on('error', (error) => {
      logger.error('Received error event from Slack', error);
    });

//    this.slack.rtm.on('message', (message) => {
//      // Ignore bot messages and people leaving/joining
//      if (message.type === 'message' &&
//        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)) {
//        this.sendToIRC(message);
//      }
//    });

    this.slack.rtm.on(RTM_EVENTS.MESSAGE, message => {
    // Ignore bot messages and people leaving/joining

    const holding = JSON.stringify(message)
    logger.debug(`MESSAGE: ${holding}
                  RTM_EVENTS.MESSAGE:${RTM_EVENTS.MESSAGE}`)
    if (message.type === 'message') {
      logger.debug(`MISSED THE MATRIX`);
      const { dataStore } = this.slack.rtm;
      const user = dataStore.getUserById(message.user);
      if (message.attachments) {
        message.text += `Posted from Giphy: ${message.attachments[0].image_url}`
      }
      if (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1) {
        if (CODE_REGEX.test(message.text)) {
          const entities = new AllHtmlEntities();
          const match = message.text.match(CODE_REGEX);
          gist({
            content: entities.decode(match[1]),
            description: 'SHACK',
            public: false,
            }, (err, resp, data) => {
            if (err == null) {
              message.text = message.text.replace(match[0], data['html_url']);
            }
            this.sendToIRC(message);
          });
        } else {
          this.sendToIRC(message);
        }
      } else if (message.subtype === RTM_MESSAGE_SUBTYPES.FILE_SHARE && message.file.mode === 'snippet') {
        const entities = new AllHtmlEntities();
        request.get({
          url: message.file.url_private,
          headers: {'Authorization': `Bearer ${this.token}`}
        }, (err, res, body) => {
          if (err != null) {
            logger.debug(body);
          } else {
            gist({
              filename: message.file.title,
              content: entities.decode(body),
              description: 'SHACK',
              public: false,
            }, (err, resp, data) => {
              if (err != null) {
                logger.debug(data);
              } else {
                message.text = `Added a ${message.file.pretty_type} snippet: ${data['html_url']}`;
                if (message.file.comments_count > 0) {
                  message.text += ` with comment: "${message.file.initial_comment.comment}"`
                }
              }            
              this.sendToIRC(message);
            });
          }
        });
      } else if (message.subtype === RTM_MESSAGE_SUBTYPES.FILE_SHARE && /image/.test(message.file.mimetype)) {
        request.get({
          url: message.file.url_private_download,
          headers: {'Authorization': `Bearer ${this.token}`},
          encoding: null
        }, (err, res, body) => {
          console.log('res: ' + JSON.stringify(res));
          if (err != null) {
            logger.debug(body);
          } else {
            const base64 = new Buffer(body, 'binary').toString('base64');
            request.post({
              url: 'https://api.imgur.com/3/image.json',
              form: {image: base64, type: 'base64'},
              headers: {'authorization': `Client-ID ${this.clientId}`}
            }, (err, res, body) => {
              if (err != null) {
                logger.debug(body);
              } else {
                let json = JSON.parse(body);
                message.text = `Added an image: ${json.data.link}`;
                if (message.file.comments_count > 0) {
                  message.text += ` with comment: "${message.file.initial_comment.comment}"`
                }
              }
              this.sendToIRC(message);
            });
          }
        });
      }
    }
    });

    this.slack.rtm.on(RTM_EVENTS.USER_CHANGE, event => {
      const { dataStore } = this.slack.rtm;
      const user = dataStore.getUserById(event.user.id);
      const client = this.ircClients[user.id];
      const ircNick = this.ircNick(user.name);
      if (event.user.presence !== 'active') return;
      if (client == null) {
        this.connectNewClient(event.user);
      } else if (ircNick !== client.nick) {
        logger.debug(`Slack user name change ${client.nick} -> ${ircNick}.`);
        client.send('NICK', ircNick);
        client.slackName = user.name;
      }
    });


    this.ircClient.on('message', this.sendToSlack.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      const formattedText = `*${text}*`;
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('action', (author, to, text) => {
      const formattedText = `_${text}_`;
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    this.ircClient.on('names', (chan, names) => {
      if (this.ircNameList == null) return;
      const userNames = _.keys(names);
      const url = this.ircNameList.url;
      const key = this.ircNameList.key;
      userNames.sort((a, b) => {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
      request.post({
        url: url,
        form: {
          key: key,
          names: userNames.join(',')
        }
      }, (err, res, body) => {
        if (err != null) {
          logger.debug(body);
        }
      });
    });

    if (this.ircStatusNotices.join) {
      this.ircClient.on('join', (channel, nick) => {
        if (nick !== this.nickname) {
          this.sendToSlack(this.nickname, channel, `*${nick}* has joined the IRC channel`);
        }
      });
    }

    if (this.ircStatusNotices.leave) {
      this.ircClient.on('part', (channel, nick) => {
        this.sendToSlack(this.nickname, channel, `*${nick}* has left the IRC channel`);
      });

      this.ircClient.on('quit', (nick, reason, channels) => {
        channels.forEach((channel) => {
          this.sendToSlack(this.nickname, channel, `*${nick}* has quit the IRC channel`);
        });
      });
    }
  }

  parseText(text) {
    const { dataStore } = this.slack.rtm;
    logger.debug(`TEXT: ${text}`)
    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#(C\w+)\|?(\w+)?>/g, (match, channelId, readable) => {
        const { name } = dataStore.getChannelById(channelId);
        return readable || `#${name}`;
      })
      .replace(/<@(U\w+)\|?(\w+)?>/g, (match, userId, readable) => {
        const { name } = dataStore.getUserById(userId);
        return readable || `@${name}`;
      })
      .replace(/<(?!!)([^|]+?)>/g, (match, link) => link)
      .replace(/<!(\w+)\|?(\w+)?>/g, (match, command, label) =>
        `<${label || command}>`
      )
      .replace(/:(\w+):/g, (match, emoji) => {
        if (emoji in emojis) {
          return emojis[emoji];
        }

        return match;
      })
      .replace(SLACK_REGEX, (match, slackName) => {
        const ircNick = this.ircNick(slackName);
        if (this.currentShadowNicks().indexOf(ircNick) > -1) {
          return ircNick;
        }
        return match;
      })
      .replace(/<.+?\|(.+?)>/g, (match, readable) => readable)
  
  }

  ircNick(slackName) {
    return slackName.replace(/\./g, '-').substr(0, SERVER_NICKLEN - this.nickSuffix.length)
      + this.nickSuffix;
  }

  isBot(userId) {
    return this.slack.rtm.dataStore.getBotByUserId(userId) != null;
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }


  sendToIRC(message) {
    const { dataStore } = this.slack.rtm;
    const channel = dataStore.getChannelGroupOrDMById(message.channel);
    if (!channel) {
      logger.info('Received message from a channel the bot isn\'t in:',
        message.channel);
      return;
    }

    if (this.muteSlackbot && message.user === 'USLACKBOT') {
      logger.debug(`Muted message from Slackbot: "${message.text}"`);
      return;
    }

    const user = dataStore.getUserById(message.user);

    if (this.muteUsers.slack.indexOf(user.name) !== -1) {
      logger.debug(`Muted message from Slack ${user.name}: ${message.text}`);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      let text = this.parseText(message.text);
      
      if (this.isCommandMessage(text)) {
        this.processCommandMessage(message);
        const prelude = `Command sent from Slack by ${user.name}:`;
        this.ircClient.say(ircChannel, prelude);
      } else if (!message.subtype) {
        text = `<${user.name}> ${text}`;
      } else if (message.subtype === 'file_share') {
        text = `<${user.name}> File uploaded ${message.file.permalink} / ${message.file.permalink_public}`;
        if (message.file.initial_comment) {
          text += ` - ${message.file.initial_comment.comment}`;
        }
      } else if (message.subtype === 'me_message') {
        text = `Action: ${user.name} ${text}`;
      }
      logger.debug('Sending message to IRC', channelName, text);
      this.ircClient.say(ircChannel, text);
    }
  }


  sendToSlack(author, channel, text) {
    const slackChannelName = this.invertedMapping[channel.toLowerCase()];
    if (slackChannelName) {
      const { dataStore } = this.slack.rtm;
      const name = slackChannelName.replace(/^#/, '');
      const slackChannel = dataStore.getChannelOrGroupByName(name);

      // If it's a private group and the bot isn't in it, we won't find anything here.
      // If it's a channel however, we need to check is_member.
      if (!slackChannel || (!slackChannel.is_member && !slackChannel.is_group)) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          slackChannelName);
        return;
      }

      if (this.muteUsers.irc.indexOf(author) !== -1) {
        logger.debug(`Muted message from IRC ${author}: ${text}`);
        return;
      }

      const currentChannelUsernames = slackChannel.members.map(member =>
        dataStore.getUserById(member).name
      );

      const currentShadowUsernames = this.currentShadowNicks();
      if (currentShadowUsernames.indexOf(author) > -1) {
        logger.debug(`Ignoring message from shadow user IRC bot '${author}'.`);
        return;
      }

      //const mappedText = currentChannelUsernames.reduce((current, username) =>
      //  highlightUsername(username, current)
      //, text);

      const replacedText = this.replaceUsernames(text);
      const convertedText = this.convertFormatting(replacedText);
      const mappedText = this.mapSlackUsers(slackChannel, convertedText);


      let iconUrl;
      if (author !== this.nickname && this.avatarUrl) {
        iconUrl = this.avatarUrl.replace(/\$username/g, author);
      }

      const options = {
        username: this.slackUsernameFormat.replace(/\$username/g, author),
        parse: 'full',
        icon_url: iconUrl
      };

      logger.debug('Sending message to Slack', mappedText, channel, '->', slackChannelName);
      this.slack.web.chat.postMessage(slackChannel.id, mappedText, options);
    }
  }
  checkActiveUsers(slackChannelName) {
    // Start clients for currently active users if option 'statusChanges' is set to true
    if (!this.statusChanges) return;
    logger.debug(`Creating clients for active users on connect for channel ${slackChannelName}.`);
    const { dataStore } = this.slack.rtm;
    const name = slackChannelName.replace(/^#/, '');
    const slackChannel = dataStore.getChannelOrGroupByName(name);
    for (const member of slackChannel.members) {
      const user = dataStore.getUserById(member);
      if (user.presence === 'active') {
        this.connectNewClient(user);
      }
    }
  }

  currentChannelUsernames(slackChannel) {
    const { dataStore } = this.slack.rtm;
    return slackChannel.members.map(member =>
      dataStore.getUserById(member).name
    );
  }

  mapSlackUsers(slackChannel, text) {
    return this.currentChannelUsernames(slackChannel).reduce((current, username) =>
      highlightUsername(username, current)
    , text);
  }

  clientChannels(client) {
    return _.keys(client.chans).map(channel =>
      client.chans[channel].serverName
    );
  }

  currentShadowNicks() {
    return _.keys(this.ircClients).map(userId =>
      this.ircClients[userId].nick
    );
  }

  replaceUsernames(text) {
    return text.replace(this.nickRegex, (match, slackNick) => {
      for (const key of _.keys(this.ircClients)) {
        const client = this.ircClients[key];
        if (client.nick === slackNick) {
          return client.slackName;
        }
      }
      return match;
    });
  }

  convertFormatting(text) {
    const converted = text.replace(/\x03\d{2}(.+?)\x0F/g, '`$1`');
    return converted.replace(/\x02(.+?)\x0F/g, '*$1*');
  }

  getIRCChannel(slackChannelID) {
    const { dataStore } = this.slack.rtm;
    const channel = dataStore.getChannelGroupOrDMById(slackChannelID);
    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    return this.channelMapping[channelName];
  }

  startAwayTimer(user, message) {
    const client = this.ircClients[user.id];
    if (client != null) {
      client.timer = setTimeout(() => {
        this.deleteClient(user, message);
      }, this.ircTimeout * 1000);
    }
  }

  clearAwayTimer(user) {
    const client = this.ircClients[user.id];
    if (client != null) {
      clearTimeout(client.timer);
    }
  }

  restartAwayTimer(user, message) {
    this.clearAwayTimer(user);
    this.startAwayTimer(user, message);
  }

  processCommandMessage(message) {
    const commandString = message.text.substring(1);
    const regex = new RegExp('^(\\w+)\\s?(\\S+)?\\s?(.*)$', 'i');
    const match = commandString.match(regex);
    const onlineUsers = onlineIRCUsers.bind(this);
    const help = commandHelp.bind(this);
    const irctopic = ircTopic.bind(this);
    const topic = setNewTopic.bind(this);
    //const priv = privMessage.bind(this);
 
    if (match == null) {
      return;
    }
    if (match.length > 1) {
      const command = match[1];
      const argument = match[2];
      const remaining = match[3];
      switch (command) {
        case 'online':
          onlineUsers(message, argument);
          break;
        case 'irctopic':
          irctopic(message);
          break;
        case 'help':
          help(message);
          break;
        case 'topic':
          topic(message, argument, remaining);
          break;
        case 'msg':
          if (remaining) {
            priv(message, argument, remaining);
          } else {
            this.slack.rtm.sendMessage('You must supply a message.', message.channel);
          }
          break;
        default:
          logger.debug('Invalid command received: ', command, argument);
      }
    }
  }

}

export default Bot;
