import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import {
  aetherOrderClassic,
  aetherOrderSeven,
  ed25519KeyPairFromSeed,
  makePermutationTranscript,
  makeReceipt,
  openTicket,
  settleTicket,
  signReceipt,
} from '../src/modules/permutation/aether/index.js';

const source = JSON.parse(
  readFileSync('tests/fixtures/aether-order-transcripts.json', 'utf8'),
) as any;
const signer = ed25519KeyPairFromSeed(
  createHash('sha256').update('aether-order/fixture/operator-key').digest('hex'),
);
const vectors = source.vectors.map((vector: any) => {
  const game = vector.context.variantId === 'classic' ? aetherOrderClassic : aetherOrderSeven;
  const context = { gameId: 'aether-order', ...vector.context };
  const transcript = makePermutationTranscript(
    vector.serverSeed,
    game,
    context,
    vector.transcript.previousCommitment,
  );
  const ticket = openTicket(game, vector.context, {
    lines: vector.ticket.lines.map((line: any) => ({
      code: line.code,
      params: line.params,
      stake: BigInt(line.stakeChips),
    })),
  });
  const settlement = settleTicket(game, transcript, ticket);
  const receipt = signReceipt(
    makeReceipt({
      transcript,
      ticket,
      settlement,
      signerId: source.operatorSignerId,
    }),
    signer.privateKey,
  );
  return {
    context: vector.context,
    receipt: {
      ...receipt,
      totalStakeChips: receipt.totalStake.toString(),
      creditedChips: receipt.credited.toString(),
      totalStake: undefined,
      credited: undefined,
    },
    serverSeed: vector.serverSeed,
    settlement: {
      capped: settlement.capped,
      creditedChips: settlement.credited.toString(),
      grossChips: settlement.gross.toString(),
      lines: settlement.lines.map((line) => ({
        code: line.code,
        params: line.params,
        stakeChips: line.stake.toString(),
        won: line.won,
        grossChips: line.gross.toString(),
      })),
      netChips: settlement.net.toString(),
      totalStakeChips: settlement.totalStake.toString(),
    },
    ticket: {
      idempotencyKey: ticket.idempotencyKey,
      lines: vector.ticket.lines,
      ticketDigest: ticket.ticketDigest,
      totalStakeChips: ticket.totalStake.toString(),
    },
    transcript,
  };
});
const output = {
  operatorPublicKey: signer.publicKeyHex,
  operatorSignerId: source.operatorSignerId,
  schemaNote: 'Frozen AETHER economics-bound v2 wire vectors.',
  vectors,
};
const prettier = await resolveConfig('tests/fixtures/aether-order-transcripts-v2.json');
writeFileSync(
  'tests/fixtures/aether-order-transcripts-v2.json',
  await format(JSON.stringify(output), { ...prettier, parser: 'json' }),
);
