/**
 * ioredis-mock for ioredis 6. ioredis-mock (written for ioredis 5) applies
 * ioredis's own reply transformers, but calls them with the reply only; since
 * ioredis 6 they also take the connection's protocol (RESP2/RESP3), so
 * ZRANGEBYSCORE ... WITHSCORES, HGETALL and the like throw. A transformer
 * called without that context gets the RESP2 one a default client uses.
 */
import { Command } from 'ioredis';
import RedisMock from 'ioredis-mock';

type ReplyTransformer = (result: unknown, context?: unknown) => unknown;

const replies = (Command as unknown as { _transformer: { reply: Record<string, ReplyTransformer> } })._transformer.reply;
for (const [commandName, transform] of Object.entries(replies)) {
  replies[commandName] = (result, context) =>
    transform(result, context ?? { commandName, protocol: 2, replyMapping: 'legacy' });
}

export default RedisMock;
