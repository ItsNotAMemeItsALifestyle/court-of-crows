import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const rooms = new Map();

const EVENTS = [
  { name: 'The Harvest Tax', effect: 'Every player collects 1 gold. Tax Dodge blocks your collection.' },
  { name: 'A Royal Wedding', effect: 'The monarch receives 2 gold from the wedding gifts.' },
  { name: 'Border Skirmish', effect: 'The richest vassal loses 2 gold to the war effort.' },
  { name: 'The King’s Feast', effect: 'The monarch pays 1 gold to each vassal who can be paid.' },
  { name: 'A Missing Heir', effect: 'Every player gains 1 influence as rival claims emerge.' },
  { name: 'The Plague Bell', effect: 'The poorest player gains 2 gold; everyone else loses 1 gold.' },
  { name: 'A Merchant’s Petition', effect: 'The player with the most influence gains 2 gold from the guild.' },
  { name: 'The Winter Levy', effect: 'Each vassal pays 1 gold to the monarch. Tax Dodge blocks the payment.' },
  { name: 'Night of Knives', effect: 'A surprise threat begins an assassination vote, even without an Assassination Plot card.' },
];
const CARDS = [
  'Patronage', 'Secret Pact', 'Royal Guard', 'Spy Network', 'Assassination Plot',
  'Counterplot', 'Tax Dodge', 'Gold Tribute', 'Blackmail', 'Mercenary Band',
  'Guild Investment', 'Court Censure',
];
const LAWS = ['Next in Line', 'Richest Vassal', 'Court Vote', 'Appointed Heir', 'Assassin Inherits'];
const DECREES = ['Royal Prerogative', 'Favor the Heir', 'Favor a Vassal', 'Change Succession'];
const CARD_EFFECTS = {
  Patronage: 'Gain 2 gold immediately.',
  'Secret Pact': 'Offer a pact to another player. They must accept. If accepted, you both gain 1 influence and form an alliance. Pact allies who back the same side in an assassination add 1 support or opposition.',
  'Royal Guard': 'Adds 1 guard against an assassination. Each guard cancels 1 support.',
  'Spy Network': 'Choose a rival. Swap a random card in your hand with a random card in theirs.',
  'Assassination Plot': 'Starts a court vote to remove the monarch. The plotter automatically supports it.',
  Counterplot: 'Adds 1 automatic opposing vote against an assassination plot.',
  'Tax Dodge': 'Avoids this round’s Harvest Tax or Winter Levy.',
  'Gold Tribute': 'Give 1 gold to the monarch; the monarch gains 1 influence.',
  Blackmail: 'Choose a rival and take up to 2 of their gold.',
  'Mercenary Band': 'Spend 1 gold to add 2 guards against an assassination.',
  'Guild Investment': 'Spend 2 gold now; collect 4 gold at the start of next round.',
  'Court Censure': 'Choose a rival. They lose 1 influence and 1 gold, if they have any.',
};
const code = () => {
  let value;
  do value = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(value));
  return value;
};
const getPlayer = (room, token) => room.players.find((p) => p.token === token);
const getById = (room, id) => room.players.find((p) => p.id === id);
const addLog = (room, message) => room.log.push(message);
const randomCard = () => CARDS[Math.floor(Math.random() * CARDS.length)];
function draw(player, count = 1) { for (let i = 0; i < count; i++) player.hand.push(randomCard()); }
function publicState(room, token) {
  const me = getPlayer(room, token);
  const vote = room.assassination?.votes?.[me?.id];
  return {
    code: room.code, phase: room.phase,
    host: room.players.find((p) => p.token === room.host)?.id,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, gold: p.gold, influence: p.influence,
      king: p.id === room.king && room.phase !== 'succession_vote',
      deposed: room.phase === 'succession_vote' && p.id === room.deposedKing,
      heir: p.id === room.heir,
      ready: Boolean(room.plays[p.id]), choice: vote?.side || null,
    })),
    you: me?.id, hand: me?.hand || [], round: room.round, target: room.target,
    event: room.event, eventEffect: EVENTS.find((e) => e.name === room.event)?.effect || '',
    log: room.log.slice(-12), succession: room.succession, king: room.king, heir: room.heir,
    successionVote: room.successionVote ? {
      submitted: Object.keys(room.successionVote.votes).length,
      required: room.players.length,
      choice: room.successionVote.votes[me?.id]?.candidate || null,
    } : null,
    assassination: room.assassination ? {
      plotters: room.assassination.plotters,
      yes: Object.values(room.assassination.votes).filter((v) => v.side === 'yes').reduce((n, v) => n + v.weight, 0),
      no: Object.values(room.assassination.votes).filter((v) => v.side === 'no').reduce((n, v) => n + v.weight, 0) + room.assassination.autoNo,
      guard: room.assassination.guard,
      choice: vote?.side || null,
    } : null,
    pactOffer: room.phase === 'pact_response' ? (() => {
      const offer = room.pactOffers[room.pactIndex];
      if (!offer) return null;
      if (offer.from !== me?.id && offer.to !== me?.id) return { private: true, canRespond: false, remaining: room.pactOffers.length - room.pactIndex };
      return { from: getById(room, offer.from)?.name, to: getById(room, offer.to)?.name, canRespond: offer.to === me?.id, proposer: offer.from === me?.id, remaining: room.pactOffers.length - room.pactIndex };
    })() : null,
    winner: room.winner,
    almanac: { cards: CARD_EFFECTS, laws: LAWS, decrees: DECREES, events: EVENTS },
  };
}
function finishIfWon(room) {
  const winner = room.players.find((p) => p.gold >= room.target);
  if (!winner) return false;
  room.phase = 'ended'; room.winner = winner.id;
  addLog(room, `${winner.name} reaches ${winner.gold} gold and claims the throne!`);
  return true;
}
function selectEvent(room) { room.event = EVENTS[Math.floor(Math.random() * EVENTS.length)].name; }
function start(room) {
  room.phase = 'play'; room.round = 1; selectEvent(room); room.plays = {};
  room.king = room.players[0].id; room.heir = room.players[1].id;
  room.deadline = Date.now() + 60000;
  addLog(room, `Round 1 begins: ${room.event}. ${room.players[0].name} wears the crown.`);
}
function nextInLine(room, excluded = room.king) {
  const start = room.players.findIndex((p) => p.id === excluded);
  for (let i = 1; i <= room.players.length; i++) {
    const candidate = room.players[(start + i) % room.players.length];
    if (candidate && candidate.id !== excluded) return candidate.id;
  }
  return room.heir;
}
function successor(room, plotter = null) {
  if (room.succession === 'Richest Vassal') {
    return [...room.players].filter((p) => p.id !== room.king).sort((a, b) => b.gold - a.gold)[0]?.id || nextInLine(room);
  }
  if (room.succession === 'Appointed Heir') return room.heir || nextInLine(room);
  if (room.succession === 'Assassin Inherits') return plotter || nextInLine(room);
  return nextInLine(room); // Also the tie-break for Court Vote.
}
function resolveCourtVote(room) {
  const totals = new Map();
  for (const vote of Object.values(room.successionVote.votes)) totals.set(vote.candidate, (totals.get(vote.candidate) || 0) + vote.weight);
  const highest = Math.max(...totals.values());
  const tied = [...totals].filter(([, score]) => score === highest).map(([candidate]) => candidate);
  const tieBreak = nextInLine(room, room.deposedKing);
  room.king = tied.includes(tieBreak) ? tieBreak : tied[0];
  room.heir = nextInLine(room, room.king);
  addLog(room, `${getById(room, room.king)?.name} wins the court vote and takes the throne.`);
  room.successionVote = null; room.deposedKing = null;
  if (!finishIfWon(room)) rotateEvent(room);
}
function beginCourtVote(room) {
  room.deposedKing = room.king;
  room.king = null;
  room.phase = 'succession_vote';
  room.successionVote = { votes: {} };
  addLog(room, 'The court must vote on the next monarch. Spend 1 influence to make your vote count double.');
}
function beginPactResponses(room, offers, after) {
  room.pactOffers = offers; room.pactIndex = 0; room.afterPacts = after;
  if (!offers.length) { continueAfterPacts(room); return; }
  room.phase = 'pact_response';
  addLog(room, 'A private Secret Pact offer is awaiting an answer.');
}
function continueAfterPacts(room) {
  if (room.phase === 'ended') return;
  const after = room.afterPacts;
  room.pactOffers = []; room.pactIndex = 0; room.afterPacts = null;
  if (after === 'assassination' && room.pendingAssassination) {
    room.assassination = room.pendingAssassination; room.pendingAssassination = null;
    room.phase = 'assassination'; room.deadline = Date.now() + 45000;
    addLog(room, 'The court must choose whether to support or oppose the plot.');
  } else if (after === 'round') rotateEvent(room);
}
function answerPact(room, responder, accepted) {
  const offer = room.pactOffers[room.pactIndex];
  if (!offer || offer.to !== responder.id) throw new Error('This pact was offered to another player.');
  if (accepted) {
    const proposer = getById(room, offer.from);
    proposer.influence++; responder.influence++;
    room.pacts.push({ a: proposer.id, b: responder.id, expires: room.round + 2 });
    addLog(room, 'A Secret Pact is accepted. Both parties gain 1 influence.');
  } else addLog(room, 'A Secret Pact is rejected.');
  room.pactIndex++;
  if (room.pactIndex >= room.pactOffers.length) continueAfterPacts(room);
  else {
    const next = room.pactOffers[room.pactIndex];
    addLog(room, 'Another private Secret Pact offer is awaiting an answer.');
  }
}
function resolveAssassination(room) {
  const votes = Object.values(room.assassination.votes);
  const yes = votes.filter((v) => v.side === 'yes').reduce((n, v) => n + v.weight, 0);
  const no = votes.filter((v) => v.side === 'no').reduce((n, v) => n + v.weight, 0) + room.assassination.autoNo;
  const guard = room.assassination.guard;
  const plotter = room.assassination.plotters[0];
  const oldKing = getById(room, room.king);
  const pacts = room.pacts.filter((p) => p.expires >= room.round);
  let yesBonus = 0; let noBonus = 0;
  for (const pact of pacts) {
    const a = room.assassination.votes[pact.a]?.side;
    const b = room.assassination.votes[pact.b]?.side;
    if (a && a === b) { if (a === 'yes') yesBonus++; else noBonus++; }
  }
  if (yes + yesBonus > no + noBonus + guard) {
    addLog(room, `${oldKing?.name || 'The monarch'} is assassinated!`);
    room.assassination = null;
    if (room.succession === 'Court Vote') { beginCourtVote(room); return; }
    room.king = successor(room, plotter);
    room.heir = nextInLine(room, room.king);
    addLog(room, `${getById(room, room.king)?.name} inherits under ${room.succession}.`);
  } else {
    addLog(room, `${oldKing?.name || 'The monarch'} survives. Opposition and guards hold.`);
    room.assassination = null;
  }
  if (!finishIfWon(room)) rotateEvent(room);
}
function applyEvent(room) {
  const king = getById(room, room.king);
  const vassals = room.players.filter((p) => p.id !== room.king);
  if (room.event === 'The Harvest Tax') {
    for (const p of room.players) if (!room.plays[p.id]?.taxDodged) p.gold++;
    addLog(room, 'Harvest Tax: each player not using Tax Dodge gains 1 gold.');
  } else if (room.event === 'A Royal Wedding') { king.gold += 2; addLog(room, 'Royal Wedding: the monarch receives 2 gold.'); }
  else if (room.event === 'Border Skirmish') {
    const richest = [...vassals].sort((a, b) => b.gold - a.gold)[0];
    if (richest) { richest.gold = Math.max(0, richest.gold - 2); addLog(room, `Border Skirmish costs ${richest.name} up to 2 gold.`); }
  } else if (room.event === 'The King’s Feast') {
    for (const p of vassals) if (king.gold > 0) { king.gold--; p.gold++; }
    addLog(room, 'King’s Feast: the monarch shares 1 gold with each vassal they can afford.');
  } else if (room.event === 'A Missing Heir') {
    room.players.forEach((p) => p.influence++); addLog(room, 'Missing Heir: every player gains 1 influence.');
  } else if (room.event === 'The Plague Bell') {
    const poorest = [...room.players].sort((a, b) => a.gold - b.gold)[0];
    for (const p of room.players) if (p.id !== poorest.id) p.gold = Math.max(0, p.gold - 1);
    poorest.gold += 2; addLog(room, `Plague Bell: ${poorest.name} gains 2 gold; everyone else loses 1.`);
  } else if (room.event === 'A Merchant’s Petition') {
    const leader = [...room.players].sort((a, b) => b.influence - a.influence)[0];
    leader.gold += 2; addLog(room, `Merchant Petition: ${leader.name}, the most influential, gains 2 gold.`);
  } else if (room.event === 'The Winter Levy') {
    for (const p of vassals) if (!room.plays[p.id]?.taxDodged && p.gold > 0) { p.gold--; king.gold++; }
    addLog(room, 'Winter Levy: each vassal not using Tax Dodge pays 1 gold to the monarch.');
  }
}
function resolveCards(room) {
  const guard = { value: 0 };
  const autoNo = { value: 0 };
  const plotters = [];
  const pactOffers = [];
  for (const p of room.players) {
    const play = room.plays[p.id];
    if (!play) continue;
    play.taxDodged = play.actions.some((a) => a.card === 'Tax Dodge');
    for (const action of play.actions) {
      const target = getById(room, action.target);
      if (action.card === 'Patronage') { p.gold += 2; addLog(room, `${p.name} gains 2 gold through patronage.`); }
      else if (action.card === 'Secret Pact' && target && target.id !== p.id) {
        pactOffers.push({ from: p.id, to: target.id });
        addLog(room, 'A player sends a private Secret Pact offer.');
      } else if (action.card === 'Royal Guard') { guard.value++; addLog(room, `${p.name} places a Royal Guard.`); }
      else if (action.card === 'Spy Network' && target && target.id !== p.id && target.hand.length) {
        const ti = Math.floor(Math.random() * target.hand.length); const pi = Math.floor(Math.random() * p.hand.length);
        const stolen = target.hand.splice(ti, 1)[0]; const exchanged = p.hand.splice(pi, 1, stolen)[0]; target.hand.push(exchanged);
        addLog(room, `${p.name}'s spies secretly trade a card with ${target.name}.`);
      } else if (action.card === 'Assassination Plot') { plotters.push(p.id); addLog(room, `${p.name} calls for the monarch's removal.`); }
      else if (action.card === 'Counterplot') { autoNo.value++; addLog(room, `${p.name} adds an automatic opposing vote with Counterplot.`); }
      else if (action.card === 'Gold Tribute') {
        const monarch = getById(room, room.king);
        if (p.gold > 0) { p.gold--; monarch.gold++; monarch.influence++; addLog(room, `${p.name} pays tribute; the monarch gains gold and influence.`); }
      } else if (action.card === 'Blackmail' && target && target.id !== p.id) {
        const stolen = Math.min(2, target.gold); target.gold -= stolen; p.gold += stolen;
        addLog(room, `${p.name} blackmails ${target.name} for ${stolen} gold.`);
      } else if (action.card === 'Mercenary Band') {
        if (p.gold > 0) { p.gold--; guard.value += 2; addLog(room, `${p.name} spends 1 gold on mercenaries: 2 guards.`); }
        else addLog(room, `${p.name} cannot afford a Mercenary Band.`);
      } else if (action.card === 'Guild Investment') {
        if (p.gold >= 2) { p.gold -= 2; room.investments.push({ player: p.id, due: room.round + 1, amount: 4 }); addLog(room, `${p.name} invests 2 gold in the guild for 4 next round.`); }
        else addLog(room, `${p.name} cannot afford a Guild Investment.`);
      } else if (action.card === 'Court Censure' && target && target.id !== p.id) {
        target.influence = Math.max(0, target.influence - 1); target.gold = Math.max(0, target.gold - 1);
        addLog(room, `${p.name} censures ${target.name}, costing them 1 influence and 1 gold.`);
      }
    }
  }
  const hasAssassination = plotters.length || room.event === 'Night of Knives';
  if (hasAssassination) {
    const votes = Object.fromEntries(plotters.map((id) => [id, { side: 'yes', weight: 1 }]));
    room.pendingAssassination = { plotters, votes, guard: guard.value, autoNo: autoNo.value };
    if (room.event === 'Night of Knives') addLog(room, 'Night of Knives: a surprise plot begins.');
    beginPactResponses(room, pactOffers, 'assassination');
    return;
  }
  if (autoNo.value) addLog(room, `Counterplot contributes ${autoNo.value} opposing vote(s).`);
  const monarch = getById(room, room.king);
  const royal = room.plays[room.king];
  const decree = royal?.decree;
  if (decree === 'Royal Prerogative') { monarch.gold += 3; monarch.influence++; addLog(room, `${monarch.name} claims 3 gold and 1 influence under Royal Prerogative.`); }
  else if (decree === 'Favor the Heir') {
    const heir = getById(room, room.heir);
    if (heir) { heir.gold += 2; heir.influence++; monarch.gold++; addLog(room, `${monarch.name} favors ${heir.name}: +2 gold and influence, +1 gold to the crown.`); }
  } else if (decree === 'Favor a Vassal') {
    const vassal = getById(room, royal?.favor);
    if (vassal && vassal.id !== monarch.id) { vassal.gold += 2; vassal.influence++; monarch.gold++; addLog(room, `${monarch.name} rewards ${vassal.name}: +2 gold and influence, +1 gold to the crown.`); }
  } else if (decree === 'Change Succession') {
    room.succession = royal.successionLaw || room.succession;
    if (room.succession === 'Appointed Heir' && getById(room, royal.appointedHeir)) room.heir = royal.appointedHeir;
    addLog(room, `${monarch.name} changes succession to ${room.succession}${room.succession === 'Appointed Heir' ? `, naming ${getById(room, room.heir)?.name}` : ''}.`);
  }
  applyEvent(room);
  if (finishIfWon(room)) return;
  beginPactResponses(room, pactOffers, 'round');
}
function payInvestments(room) {
  const due = room.investments.filter((item) => item.due <= room.round);
  room.investments = room.investments.filter((item) => item.due > room.round);
  for (const item of due) {
    const player = getById(room, item.player);
    if (player) { player.gold += item.amount; addLog(room, `${player.name}'s Guild Investment returns ${item.amount} gold.`); }
  }
}
function rotateEvent(room) {
  room.round++; room.plays = {}; selectEvent(room); room.phase = 'play';
  room.deadline = Date.now() + 60000; room.pacts = room.pacts.filter((p) => p.expires >= room.round);
  room.players.forEach((p) => draw(p, 1)); payInvestments(room);
  if (finishIfWon(room)) return;
  addLog(room, `Round ${room.round}: ${room.event}. The crown remains with ${getById(room, room.king)?.name}.`);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/create' && req.method === 'POST') {
      const data = await body(req); const roomCode = code(); const token = randomUUID();
      const room = {
        code: roomCode, phase: 'lobby', host: token,
        players: [{ id: randomUUID(), token, name: (data.name || 'Player').slice(0, 16), gold: 4, influence: 0, hand: [] }],
        king: null, heir: null, target: 20, round: 0, event: null, log: ['Welcome to court. Invite 1–7 rivals with this room code.'],
        plays: {}, succession: 'Next in Line', deadline: null, assassination: null, successionVote: null,
        investments: [], pacts: [], pactOffers: [], pactIndex: 0, afterPacts: null, pendingAssassination: null,
      };
      draw(room.players[0], 5); rooms.set(roomCode, room);
      json(res, { token, state: publicState(room, token) }); return;
    }
    const match = url.pathname.match(/^\/api\/(join|state|start|play|vote|succession|pact)\/([A-Z0-9]+)$/);
    if (match) {
      const [, action, roomCode] = match; const room = rooms.get(roomCode);
      if (!room) { json(res, { error: 'Room not found.' }, 404); return; }
      const data = req.method === 'POST' ? await body(req) : {};
      if (action === 'join') {
        if (room.phase !== 'lobby') { json(res, { error: 'This court has already begun.' }, 409); return; }
        if (room.players.length >= 8) { json(res, { error: 'This court is full.' }, 409); return; }
        const token = randomUUID(); const p = { id: randomUUID(), token, name: (data.name || 'Player').slice(0, 16), gold: 4, influence: 0, hand: [] };
        draw(p, 5); room.players.push(p); addLog(room, `${p.name} joins the court.`);
        json(res, { token, state: publicState(room, token) }); return;
      }
      const token = data.token || url.searchParams.get('token'); const me = getPlayer(room, token);
      if (!me) { json(res, { error: 'You are not in this room.' }, 403); return; }
      if (action === 'state') { json(res, { state: publicState(room, token) }); return; }
      if (action === 'start') {
        if (token !== room.host) { json(res, { error: 'Only the host can begin the game.' }, 403); return; }
        if (room.players.length < 2) { json(res, { error: 'Invite at least one more player before starting.' }, 400); return; }
        if (room.phase === 'lobby') start(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'play') {
        if (room.phase !== 'play') { json(res, { error: 'The court is not taking actions now.' }, 409); return; }
        if (room.plays[me.id]) { json(res, { error: 'Your cards are already committed.' }, 409); return; }
        const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : [];
        if (!actions.length || actions.some((a) => !me.hand.includes(a.card))) { json(res, { error: 'Choose one or two cards from your hand.' }, 400); return; }
        for (const a of actions) me.hand.splice(me.hand.indexOf(a.card), 1);
        draw(me, actions.length);
        room.plays[me.id] = {
          actions, decree: me.id === room.king ? data.decree : null,
          favor: data.favor || null, successionLaw: data.successionLaw || null,
          appointedHeir: data.appointedHeir || null,
        };
        addLog(room, `${me.name} commits their cards.`);
        if (room.players.every((p) => room.plays[p.id])) resolveCards(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'vote') {
        if (room.phase !== 'assassination') { json(res, { error: 'There is no active plot.' }, 409); return; }
        if (!room.assassination.votes[me.id]) {
          const spend = Boolean(data.spendInfluence) && me.influence > 0;
          if (spend) me.influence--;
          room.assassination.votes[me.id] = { side: data.vote === 'yes' ? 'yes' : 'no', weight: spend ? 2 : 1 };
        }
        if (room.players.every((p) => room.assassination.votes[p.id])) resolveAssassination(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'pact') {
        if (room.phase !== 'pact_response') { json(res, { error: 'There is no pact waiting for your answer.' }, 409); return; }
        try { answerPact(room, me, Boolean(data.accept)); }
        catch (error) { json(res, { error: error.message }, 403); return; }
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'succession') {
        if (room.phase !== 'succession_vote') { json(res, { error: 'The court is not voting on succession.' }, 409); return; }
        if (!room.successionVote.votes[me.id]) {
          const candidate = getById(room, data.candidate);
          if (!candidate) { json(res, { error: 'Choose a player for the throne.' }, 400); return; }
          const spend = Boolean(data.spendInfluence) && me.influence > 0;
          if (spend) me.influence--;
          room.successionVote.votes[me.id] = { candidate: candidate.id, weight: spend ? 2 : 1 };
          addLog(room, `${me.name} casts a succession vote${spend ? ' using influence' : ''}.`);
        }
        if (room.players.every((p) => room.successionVote.votes[p.id])) resolveCourtVote(room);
        json(res, { state: publicState(room, token) }); return;
      }
    }
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await readFile(path.join(root, 'index.html'))); return; }
    res.writeHead(404); res.end('Not found');
  } catch (error) { json(res, { error: error.message || 'Server error' }, 500); }
});
function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (error) { reject(error); } });
  });
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
server.listen(port, '0.0.0.0', () => console.log(`Court of Crows running at http://localhost:${port}`));
