import type { OptDef } from 'optist';
import ou from 'optist/util.js';

import { parseTimespec } from './options.js';

/**
 * The options of tr-ai-intercom-notify.
 *
 * Every option names its environment variable in its own definition,
 * INTERCOM_NOTIFY_OPT_ followed by the option name in upper case with dashes
 * as underscores.
 */
export const NOTIFY_OPTIONS: OptDef[] = [
  {
    longName: 'monitor',
    environment: 'INTERCOM_NOTIFY_OPT_MONITOR',
    description: 'Print every notification as it arrives, until stopped.',
    conflictsWith: 'oneshot',
  },
  {
    longName: 'oneshot',
    environment: 'INTERCOM_NOTIFY_OPT_ONESHOT',
    description: 'Print the first notification and end.',
    conflictsWith: ['monitor', 'reconnect'],
  },
  {
    longName: 'reconnect',
    environment: 'INTERCOM_NOTIFY_OPT_RECONNECT',
    description:
      'With --monitor: when the helper cannot be reached or goes away, keep trying every few seconds instead of ending.',
    requiresAlso: 'monitor',
  },
  {
    longName: 'helper-port',
    environment: 'INTERCOM_NOTIFY_OPT_HELPER_PORT',
    description:
      'The local port the helper listens on (its --listen-port). The socket is found from it: /tmp/tr-ai-intercom-helper.<uid>/<port>.sock.',
    hasArg: true,
    conflictsWith: 'socket-path',
    optArgCb: ou.integerWithLimitsCbFactory(1, 65535),
  },
  {
    longName: 'socket-path',
    environment: 'INTERCOM_NOTIFY_OPT_SOCKET_PATH',
    description: 'The socket of the helper, when it was started with --notification-listener-path.',
    hasArg: true,
    conflictsWith: 'helper-port',
    optArgCb: ou.nonEmptyCb,
  },
  {
    longName: 'idle-notification-interval',
    environment: 'INTERCOM_NOTIFY_OPT_IDLE_NOTIFICATION_INTERVAL',
    description:
      'Print a notification of its own, with the message "local-idle-notification", whenever nothing has been printed for this long, and again each time that long passes. Its data.idle is the number of seconds since the last notification from the helper. In seconds, or with a unit: 90, 15m, 2h, 1d. Without it nothing is printed while nothing happens.',
    hasArg: true,
    optArgCb: (s: string) => {
      const seconds = parseTimespec(s);
      return seconds !== undefined && seconds > 0 ? seconds : undefined;
    },
  },
];
