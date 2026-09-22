import axios from 'axios';
import { logger } from '@support-agent-aws/shared';

export class SlackClient {
  private token: string;

  constructor(userToken: string) {
    this.token = userToken;
  }

  /**
   * Post a message to a Slack channel
   * @param channel - Channel ID
   * @param text - Message text
   * @param threadTs - Optional thread timestamp to reply in a thread
   */
  async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    logger.debug('Posting Slack message', { channel, threadTs, textLength: text.length });

    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel,
        text,
        thread_ts: threadTs,
      },
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    logger.debug('Slack message posted successfully');
  }
}
