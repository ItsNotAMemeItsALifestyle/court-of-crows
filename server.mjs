import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const rooms = new Map();
const HAND_LIMIT = 10;
const INFLUENCE_LIMIT = 3;

const EVENTS = [
  { name: 'The Harvest Tax', effect: 'Every player gains 1 gold. Tax Dodge earns its player 1 extra gold.' },
  { name: 'A Royal Wedding', effect: 'The monarch receives 2 gold from the wedding gifts.' },
  { name: 'Border Skirmish', effect: 'The richest vassal loses 2 gold to the war effort.' },
  { name: 'The King’s Feast', effect: 'The monarch pays 1 gold to each vassal who can be paid.' },
  { name: 'A Missing Heir', effect: 'Every player gains 1 influence as rival claims emerge.' },
  { name: 'The Plague Bell', effect: 'The poorest player gains 2 gold; everyone else loses 1 gold.' },
  { name: 'A Merchant’s Petition', effect: 'The player with the most influence gains 2 gold from the guild.' },
  { name: 'The Winter Levy', effect: 'Each vassal pays 1 gold to the monarch unless they play Tax Dodge.' },
  { name: 'Night of Knives', effect: 'A surprise threat begins an assassination vote, even without an Assassination Plot card.' },
];
const CARDS = [
  'Patronage', 'Secret Pact', 'Royal Guard', 'Spy Network', 'Assassination Plot',
  'Counterplot', 'Tax Dodge', 'Gold Tribute', 'Blackmail', 'Mercenary Band',
  'Guild Investment', 'Court Censure',
  'Hidden Blade', 'Pilgrim’s Alms', 'Royal Writ', 'King’s Bounty',
  'Letters of Protection', 'Petition for Redress', 'Poisoned Wine',
];
const LAWS = ['Next in Line', 'Richest Vassal', 'Court Vote', 'Appointed Heir', 'Assassin Inherits'];
const DECREES = ['Royal Prerogative', 'Favor the Heir', 'Favor a Vassal', 'Change Succession', 'Court Appointment'];
const OFFICES = {
  Spymaster: 'Your assassination ballot counts twice. This cannot stack with spending influence.',
  Chancellor: 'Choose another vassal to gain 1 influence each turn. A Favor decree replaces this grant.',
  Treasurer: 'When the monarch uses Royal Prerogative, divert 1 of its 3 gold to a vassal you choose.',
  Marshal: 'When you oppose an assassination, add 1 extra royal guard.',
};
const OFFICE_NAMES = Object.keys(OFFICES);
function officeLimit(playerCount) { return playerCount <= 2 ? 0 : playerCount <= 4 ? 1 : playerCount <= 6 ? 2 : 3; }
const CARD_EFFECTS = {
  Patronage: 'Gain 2 gold immediately. Combo: if paired with Secret Pact and accepted, both players also gain 1 gold.',
  'Secret Pact': 'Offer a pact to another player. They must accept. If accepted, you both gain 1 influence and form an alliance. Pact allies who back the same side in an assassination add 1 support or opposition.',
  'Royal Guard': 'Adds 1 guard against an assassination. Each guard cancels 1 support. Combo: with Mercenary Band, add 1 extra guard.',
  'Spy Network': 'Choose a rival. Swap a random card in your hand with a random card in theirs.',
  'Assassination Plot': 'Starts a court vote to remove the monarch. The plotter automatically supports it.',
  Counterplot: 'Adds 1 automatic opposing vote against an assassination plot.',
  'Tax Dodge': 'During Harvest Tax, gain 2 gold instead of 1. During Winter Levy, keep the 1 gold you would have paid.',
  'Gold Tribute': 'Vassal: pay 1 gold to the monarch and gain 1 influence. Monarch: choose a vassal to pay you 1 gold; gain 1 influence.',
  Blackmail: 'Choose a rival and take up to 2 of their gold. Combo: when aimed at the same rival as Court Censure, they also lose 1 extra influence.',
  'Mercenary Band': 'Spend 1 gold to add 2 guards against an assassination. Combo: with Royal Guard, add 1 extra guard.',
  'Guild Investment': 'Spend 2 gold now; collect 4 gold at the start of next round.',
  'Court Censure': 'Choose a rival. They lose 1 influence and 1 gold, if they have any. Combo: when aimed at the same rival as Blackmail, they also lose 1 extra influence.',
  'Hidden Blade': 'If you are a vassal, add 1 support to an assassination vote this round. If you are monarch, it instead adds 1 guard.',
  'Pilgrim’s Alms': 'If you have 5 gold or less, gain 2 gold. Otherwise, gain 1 influence.',
  'Royal Writ': 'Choose a rival and transfer 1 of their influence to yourself, if they have any.',
  'King’s Bounty': 'Choose plot or defense. If an assassination vote happens and your side wins, gain 2 gold; if it loses, lose up to 1 gold. No vote means no wager result.',
  'Letters of Protection': 'Choose any player, including yourself. Cancel the first targeted scheme played against them this turn.',
  'Petition for Redress': 'Choose a vassal, including yourself. If the monarch uses Royal Prerogative, they claim 1 of its 3 gold; otherwise they gain 1 influence. Further petitions beyond the 3-gold claim grant 1 influence instead.',
  'Poisoned Wine': 'Spend 1 gold whether or not a plot begins. As a vassal, add 2 plot support; as monarch, add 2 royal guards.',
};
const CARD_COMBOS = [
  { name: 'Royal Treasury', cards: 'Patronage + Secret Pact', effect: 'If the pact is accepted, both players also gain 1 gold.' },
  { name: 'Coordinated Defense', cards: 'Royal Guard + Mercenary Band', effect: 'Add 1 extra guard against the assassination.' },
  { name: 'Coercive Audit', cards: 'Blackmail + Court Censure on the same rival', effect: 'That rival loses 1 extra influence.' },
  { name: 'Veiled Conspiracy', cards: 'Assassination Plot + Hidden Blade', effect: 'The Hidden Blade adds 1 support to the plot.' },
];
const code = () => {
  let value;
  do value = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(value));
  return value;
};
const getPlayer = (room, token) => room.players.find((p) => p.token === token);
const getById = (room, id) => room.players.find((p) => p.id === id);
const addLog = (room, message) => { room.log.push(message); if (room.matchLog) room.matchLog.push(message); };
const CARD_WEIGHTS = { 'Tax Dodge': 0.4, 'Gold Tribute': 0.4 };
function randomCard(player) {
  const fresh = CARDS.filter((card) => !player.hand.includes(card));
  const pool = fresh.length ? fresh : CARDS;
  const total = pool.reduce((sum, card) => sum + (CARD_WEIGHTS[card] || 1), 0);
  let ticket = Math.random() * total;
  for (const card of pool) { ticket -= CARD_WEIGHTS[card] || 1; if (ticket < 0) return card; }
  return pool[pool.length - 1];
}
function draw(player, count = 1) { for (let i = 0; i < count && player.hand.length < HAND_LIMIT; i++) player.hand.push(randomCard(player)); }
function gainInfluence(player, amount = 1) {
  const before = Math.min(INFLUENCE_LIMIT, Math.max(0, Number(player.influence) || 0));
  player.influence = Math.min(INFLUENCE_LIMIT, before + amount);
  return player.influence - before;
}
function castAssassinationVote(room, player, choice, spendRequested = false) {
  const side = choice === 'yes' ? 'yes' : 'no';
  const spend = player.office !== 'Spymaster' && Boolean(spendRequested) && player.influence > 0;
  if (spend) player.influence--;
  const weight = player.office === 'Spymaster' || spend ? 2 : 1;
  room.assassination.votes[player.id] = { side, weight };
  if (side === 'no' && player.office === 'Marshal') room.assassination.guard++;
  addLog(room, `${player.name} votes to ${side === 'yes' ? 'support' : 'oppose'} the plot${player.office === 'Spymaster' ? ' with the Spymaster’s double ballot' : spend ? ', spending influence for a double vote' : ''}${side === 'no' && player.office === 'Marshal' ? '; the Marshal adds 1 guard' : ''}.`);
}
function publicState(room, token) {
  for (const player of room.players) player.influence = Math.min(INFLUENCE_LIMIT, Math.max(0, Number(player.influence) || 0));
  const me = getPlayer(room, token);
  const vote = room.assassination?.votes?.[me?.id];
  return {
    code: room.code, phase: room.phase, handLimit: HAND_LIMIT, influenceLimit: INFLUENCE_LIMIT,
    host: room.players.find((p) => p.token === room.host)?.id,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, gold: p.gold, influence: p.influence, office: p.office || null,
      bot: Boolean(p.bot),
      king: p.id === room.king && room.phase !== 'succession_vote',
      deposed: room.phase === 'succession_vote' && p.id === room.deposedKing,
      heir: p.id === room.heir,
      ready: Boolean(room.plays[p.id]), choice: vote?.side || null,
    })),
    you: me?.id, hand: me?.hand || [], round: room.round, target: room.target,
    event: room.event, eventEffect: EVENTS.find((e) => e.name === room.event)?.effect || '',
    chat: (room.chat || []).slice(-40),
    log: (room.matchLog || room.log).slice(), succession: room.succession, king: room.king, heir: room.heir,
    successionVote: room.successionVote ? {
      submitted: Object.keys(room.successionVote.votes).length,
      required: room.players.length,
      choice: room.successionVote.votes[me?.id]?.candidate || null,
    } : null,
    assassination: room.assassination ? {
      plotters: room.assassination.plotters,
      yes: Object.values(room.assassination.votes).filter((v) => v.side === 'yes').reduce((n, v) => n + v.weight, 0) + (room.assassination.yesBonus || 0),
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
    matchLog: room.phase === 'ended'
      ? (room.matchLog?.some((line) => line.startsWith('Round 1 begins:')) ? room.matchLog : room.log).slice()
      : null,
    officeLimit: officeLimit(room.players.length),
    almanac: { cards: CARD_EFFECTS, combos: CARD_COMBOS, laws: LAWS, decrees: DECREES, events: EVENTS, offices: OFFICES },
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
  room.phase = 'play'; room.round = 1; selectEvent(room); room.plays = {}; room.matchLog = [];
  room.king = room.players[0].id; room.heir = room.players[1].id;
  room.deadline = Date.now() + 60000;
  addLog(room, `Round 1 begins: ${room.event}. ${room.players[0].name} wears the crown.`);
  scheduleBot(room);
}

const BOT_NAMES = ['Mara Vane', 'Edric Vale', 'Ysabel Thorn', 'Oswin Reed', 'Nell Ashford', 'Hugh Bell', 'Alys Rook'];
function botAction(room, bot) {
  if (room.phase === 'play' && !room.plays[bot.id]) {
    const hand = [...bot.hand];
    const prefers = bot.id === room.king
      ? ['Patronage','Guild Investment','Royal Guard','Tax Dodge','Counterplot','Blackmail','Court Censure','Assassination Plot','Secret Pact','Spy Network','Gold Tribute','Mercenary Band','Hidden Blade','Royal Writ','Pilgrim’s Alms','King’s Bounty','Letters of Protection','Petition for Redress','Poisoned Wine']
      : ['Patronage','Blackmail','Guild Investment','Tax Dodge','Assassination Plot','Secret Pact','Court Censure','Spy Network','Royal Guard','Counterplot','Mercenary Band','Gold Tribute','Hidden Blade','Royal Writ','Pilgrim’s Alms','King’s Bounty','Letters of Protection','Petition for Redress','Poisoned Wine'];
    const first = prefers.find((card) => hand.includes(card)) || hand[0];
    const second = hand.find((card) => card !== first && (card === 'Patronage' || card === 'Royal Guard' || card === 'Tax Dodge' || card === 'Court Censure'));
    const actions = [first, ...(second ? [second] : [])].map((card) => {
      const rivals = room.players.filter((p) => p.id !== bot.id);
      let target = rivals[0]?.id;
      if (['Blackmail','Court Censure'].includes(card)) target = [...rivals].sort((a,b) => b.gold-a.gold)[0]?.id || target;
      if (card === 'Secret Pact') target = [...rivals].sort((a,b) => (a.king ? 1 : 0)-(b.king ? 1 : 0) || a.influence-b.influence)[0]?.id || target;
      if (card === 'Letters of Protection') target = bot.id;
      if (card === 'Petition for Redress') target = bot.id === room.king ? [...rivals].filter(p => p.id !== room.king).sort((a,b) => a.gold-b.gold)[0]?.id || target : bot.id;
      if (card === 'Gold Tribute' && bot.id === room.king) target = [...rivals].filter(p => p.id !== room.king).sort((a,b) => b.gold-a.gold)[0]?.id || target;
      const bountySide = card === 'King’s Bounty' ? (bot.id === room.king || (room.heir !== bot.id && bot.gold >= (getById(room, room.king)?.gold || 0)) ? 'no' : 'yes') : undefined;
      return { card, target, bountySide };
    });
    for (const {card} of actions) bot.hand.splice(bot.hand.indexOf(card),1);
    let decree = null, favor = null, appointmentRole = null, appointmentTarget = null;
    if (bot.id === room.king) {
      const heir = getById(room, room.heir);
      const freeRole = OFFICE_NAMES.find((office) => !room.players.some((player) => player.office === office));
      const unappointed = room.players.filter((player) => player.id !== room.king && !player.office);
      if (freeRole && unappointed.length && room.players.filter((player) => player.office).length < officeLimit(room.players.length) && Math.random() < .18) {
        decree = 'Court Appointment'; appointmentRole = freeRole; appointmentTarget = unappointed.sort((a, b) => a.gold - b.gold)[0].id;
      } else if (heir && heir.gold < bot.gold + 4 && heir.gold < room.target - 2 && Math.random() < .24) { decree = 'Favor the Heir'; }
      else if (room.players.some(p => p.id !== bot.id && p.gold > bot.gold + 3) && Math.random() < .16) {
        decree = 'Favor a Vassal'; favor = [...room.players].filter(p => p.id !== bot.id).sort((a,b) => a.gold-b.gold)[0]?.id;
      } else decree = 'Royal Prerogative';
    }
    const officeTarget = bot.office === 'Chancellor'
      ? [...room.players].filter((p) => p.id !== room.king && p.id !== bot.id).sort((a, b) => a.influence - b.influence)[0]?.id
      : bot.office === 'Treasurer'
        ? [...room.players].filter((p) => p.id !== room.king).sort((a, b) => a.gold - b.gold)[0]?.id
        : null;
    room.plays[bot.id] = { actions, decree, favor, officeTarget, appointmentAction: 'appoint', appointmentRole, appointmentTarget, successionCost: 0 };
    addLog(room, `${bot.name} commits their cards.`);
    if (room.players.every((p) => room.plays[p.id])) resolveCards(room);
    return;
  }
  if (room.phase === 'pact_response') {
    const offer = room.pactOffers[room.pactIndex];
    if (offer?.to === bot.id) { answerPact(room, bot, true); return; }
  }
  if (room.phase === 'assassination' && !room.assassination.votes[bot.id]) {
    const king = getById(room, room.king);
    const yes = bot.id !== room.king && (bot.id === room.heir || (king && king.gold >= bot.gold + 3) || room.assassination.plotters.length >= 2);
    const spend = bot.influence > 0 && Math.random() < .25;
    castAssassinationVote(room, bot, yes ? 'yes' : 'no', spend);
    if (room.players.every((p) => room.assassination.votes[p.id])) resolveAssassination(room);
    return;
  }
  if (room.phase === 'succession_vote' && !room.successionVote.votes[bot.id]) {
    const candidates = room.players.filter(p => p.id !== room.deposedKing);
    const candidate = [...candidates].sort((a,b) => { const rank = p => (p.id === bot.id ? 3 : 0) + (p.heir ? 2 : 0) + p.gold * .04; return rank(b) - rank(a); })[0] || bot;
    const spend = bot.influence > 0 && Math.random() < .2;
    if (spend) bot.influence--;
    room.successionVote.votes[bot.id] = { candidate: candidate.id, weight: spend ? 2 : 1 };
    addLog(room, `${bot.name} casts a succession vote${spend ? ' using influence' : ''}.`);
    if (room.players.every((p) => room.successionVote.votes[p.id])) resolveCourtVote(room);
  }
}
function scheduleBot(room) {
  if (room.botScheduled || room.phase === 'lobby' || room.phase === 'ended') return;
  const bot = room.players.find((p) => {
    if (!p.bot) return false;
    if (room.phase === 'play') return !room.plays[p.id];
    if (room.phase === 'pact_response') return room.pactOffers[room.pactIndex]?.to === p.id;
    if (room.phase === 'assassination') return !room.assassination.votes[p.id];
    if (room.phase === 'succession_vote') return !room.successionVote.votes[p.id];
    return false;
  });
  if (!bot) return;
  room.botScheduled = true;
  setTimeout(() => {
    room.botScheduled = false;
    if (!rooms.has(room.code)) return;
    botAction(room, bot);
    scheduleBot(room);
  }, 650 + Math.floor(Math.random() * 650));
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
  const proposer = getById(room, offer.from);
  if (accepted) {
    const proposerInfluence = gainInfluence(proposer); const responderInfluence = gainInfluence(responder);
    if (offer.patronageCombo) { proposer.gold++; responder.gold++; }
    room.pacts.push({ a: proposer.id, b: responder.id, expires: room.round + 2 });
    addLog(room, `${responder.name} accepts ${proposer.name}'s Secret Pact. They gain ${proposerInfluence} and ${responderInfluence} influence${offer.patronageCombo ? ' and 1 gold through the Royal Treasury combo' : ''}.`);
  } else addLog(room, `${responder.name} rejects ${proposer?.name || 'the courtier'}'s Secret Pact.`);
  room.pactIndex++;
  if (room.pactIndex >= room.pactOffers.length) continueAfterPacts(room);
  else {
    const next = room.pactOffers[room.pactIndex];
    addLog(room, 'Another private Secret Pact offer is awaiting an answer.');
  }
}
function resolveAssassination(room) {
  const votes = Object.values(room.assassination.votes);
  const yes = votes.filter((v) => v.side === 'yes').reduce((n, v) => n + v.weight, 0) + (room.assassination.yesBonus || 0);
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
  const plotSucceeds = yes + yesBonus > no + noBonus + guard;
  addLog(room, `The plot draws ${yes + yesBonus} support against ${no + noBonus} opposition and ${guard} royal guard${guard === 1 ? '' : 's'}.`);
  for (const player of room.players) {
    for (const action of room.plays[player.id]?.actions || []) {
      if (action.card !== 'King’s Bounty') continue;
      const wins = (action.bountySide === 'no' ? 'no' : 'yes') === (plotSucceeds ? 'yes' : 'no');
      if (wins) { player.gold += 2; addLog(room, `${player.name}'s King’s Bounty pays off: +2 gold.`); }
      else { player.gold = Math.max(0, player.gold - 1); addLog(room, `${player.name}'s King’s Bounty fails: -1 gold.`); }
    }
  }
  if (plotSucceeds) {
    addLog(room, `${oldKing?.name || 'The monarch'} is assassinated!`);
    for (const player of room.players) player.office = null;
    addLog(room, 'All royal offices are stripped in the succession crisis.');
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
    for (const p of room.players) p.gold += room.plays[p.id]?.taxDodged ? 2 : 1;
    addLog(room, 'Harvest Tax: each player gains 1 gold; Tax Dodge earns its player 1 extra gold.');
  } else if (room.event === 'A Royal Wedding') { king.gold += 2; addLog(room, 'Royal Wedding: the monarch receives 2 gold.'); }
  else if (room.event === 'Border Skirmish') {
    const richest = [...vassals].sort((a, b) => b.gold - a.gold)[0];
    if (richest) { richest.gold = Math.max(0, richest.gold - 2); addLog(room, `Border Skirmish costs ${richest.name} up to 2 gold.`); }
  } else if (room.event === 'The King’s Feast') {
    for (const p of vassals) if (king.gold > 0) { king.gold--; p.gold++; }
    addLog(room, 'King’s Feast: the monarch shares 1 gold with each vassal they can afford.');
  } else if (room.event === 'A Missing Heir') {
    room.players.forEach((p) => gainInfluence(p)); addLog(room, `Missing Heir: the court gains influence, up to the ${INFLUENCE_LIMIT}-point limit.`);
  } else if (room.event === 'The Plague Bell') {
    const poorest = [...room.players].sort((a, b) => a.gold - b.gold)[0];
    for (const p of room.players) if (p.id !== poorest.id) p.gold = Math.max(0, p.gold - 1);
    poorest.gold += 2; addLog(room, `Plague Bell: ${poorest.name} gains 2 gold; everyone else loses 1.`);
  } else if (room.event === 'A Merchant’s Petition') {
    const leader = [...room.players].sort((a, b) => b.influence - a.influence)[0];
    leader.gold += 2; addLog(room, `Merchant Petition: ${leader.name}, the most influential, gains 2 gold.`);
  } else if (room.event === 'The Winter Levy') {
    for (const p of vassals) if (!room.plays[p.id]?.taxDodged && p.gold > 0) { p.gold--; king.gold++; }
    addLog(room, 'Winter Levy: each vassal without Tax Dodge pays 1 gold to the monarch.');
  }
}
function resolveCourtAppointment(room, royal) {
  const target = getById(room, royal.appointmentTarget);
  if (royal.appointmentAction === 'dismiss') {
    const formerOffice = target?.office;
    if (target && formerOffice) {
      target.office = null;
      addLog(room, `${getById(room, room.king)?.name} dismisses ${target.name} as ${formerOffice}.`);
    }
    return;
  }
  if (!target || !royal.appointmentRole) return;
  const currentHolder = room.players.find((player) => player.office === royal.appointmentRole);
  if (currentHolder && currentHolder.id !== target.id) {
    currentHolder.office = null;
    addLog(room, `${currentHolder.name} is removed as ${royal.appointmentRole}.`);
  }
  target.office = royal.appointmentRole;
  addLog(room, `${getById(room, room.king)?.name} appoints ${target.name} as ${royal.appointmentRole}. The office takes effect next turn.`);
}
function resolveCards(room) {
  const guard = { value: 0 };
  const yesBonus = { value: 0 };
  const autoNo = { value: 0 };
  const plotters = [];
  const pactOffers = [];
  const petitions = [];
  const protectedPlayers = new Map();
  const cancelableTargets = new Set(['Spy Network', 'Blackmail', 'Court Censure', 'Royal Writ', 'Gold Tribute']);
  for (const player of room.players) {
    for (const action of room.plays[player.id]?.actions || []) {
      if (action.card !== 'Letters of Protection') continue;
      const protectedPlayer = getById(room, action.target);
      if (!protectedPlayer) continue;
      protectedPlayers.set(protectedPlayer.id, (protectedPlayers.get(protectedPlayer.id) || 0) + 1);
      addLog(room, `${player.name} issues Letters of Protection for ${protectedPlayer.name}.`);
    }
  }
  const isProtected = (target, card) => {
    const charges = target && cancelableTargets.has(card) ? protectedPlayers.get(target.id) || 0 : 0;
    if (!charges) return false;
    protectedPlayers.set(target.id, charges - 1);
    addLog(room, `${target.name}'s Letters of Protection cancel ${card}.`);
    return true;
  };
  const resolvePetitions = (royalPrerogative) => {
    let claims = 0;
    for (const petition of petitions) {
      const recipient = getById(room, petition.target);
      if (!recipient) continue;
      if (royalPrerogative && recipient.id !== room.king && claims < 3) {
        recipient.gold++;
        claims++;
        addLog(room, `${petition.player.name}'s Petition for Redress grants ${recipient.name} 1 of the crown's Royal Prerogative gold.`);
      } else {
        const gained = gainInfluence(recipient);
        addLog(room, `${petition.player.name}'s Petition for Redress grants ${gained} influence to ${recipient.name}.`);
      }
    }
    return claims;
  };
  for (const p of room.players) {
    const play = room.plays[p.id];
    if (!play) continue;
    let mercenaryUsed = false;
    play.taxDodged = play.actions.some((a) => a.card === 'Tax Dodge');
    for (const action of play.actions) {
      const target = getById(room, action.target);
      if (action.card === 'Letters of Protection') continue;
      if (action.card === 'King’s Bounty') { addLog(room, `${p.name} places a secret King’s Bounty wager.`); }
      else if (action.card === 'Petition for Redress') { if (target) petitions.push({ player: p, target: target.id }); }
      else if (action.card === 'Patronage') { p.gold += 2; addLog(room, `${p.name} gains 2 gold through patronage.`); }
      else if (action.card === 'Secret Pact' && target && target.id !== p.id) {
        pactOffers.push({ from: p.id, to: target.id, patronageCombo: play.actions.some((a) => a.card === 'Patronage') });
        addLog(room, `${p.name} offers a Secret Pact to ${target.name}${play.actions.some((card) => card.card === 'Patronage') ? ' through the Royal Treasury combo' : ''}.`);
      } else if (action.card === 'Royal Guard') { guard.value++; addLog(room, `${p.name} places a Royal Guard.`); }
      else if (action.card === 'Spy Network' && target && target.id !== p.id && target.hand.length) {
        if (!isProtected(target, action.card)) {
          const ti = Math.floor(Math.random() * target.hand.length); const pi = Math.floor(Math.random() * p.hand.length);
          const stolen = target.hand.splice(ti, 1)[0]; const exchanged = p.hand.splice(pi, 1, stolen)[0]; target.hand.push(exchanged);
          addLog(room, `${p.name}'s spies secretly trade a card with ${target.name}.`);
        }
      } else if (action.card === 'Assassination Plot') { plotters.push(p.id); addLog(room, `${p.name} calls for the monarch's removal.`); }
      else if (action.card === 'Counterplot') { autoNo.value++; addLog(room, `${p.name} adds an automatic opposing vote with Counterplot.`); }
      else if (action.card === 'Gold Tribute') {
        const monarch = getById(room, room.king);
        if (p.id === room.king && target && target.id !== p.id) {
          if (!isProtected(target, action.card) && target.gold > 0) {
            target.gold--; p.gold++; const gained = gainInfluence(p);
            addLog(room, `${p.name} demands 1 gold tribute from ${target.name} and gains ${gained} influence.`);
          } else if (target.gold <= 0) addLog(room, `${target.name} has no gold to pay ${p.name}'s tribute.`);
        } else if (p.gold > 0) { p.gold--; monarch.gold++; const gained = gainInfluence(p); addLog(room, `${p.name} pays 1 gold tribute to ${monarch.name} and gains ${gained} influence.`); }
        else addLog(room, `${p.name} cannot afford Gold Tribute.`);
      } else if (action.card === 'Blackmail' && target && target.id !== p.id) {
        if (!isProtected(target, action.card)) {
          const stolen = Math.min(2, target.gold); target.gold -= stolen; p.gold += stolen;
          addLog(room, `${p.name} blackmails ${target.name} for ${stolen} gold.`);
        }
      } else if (action.card === 'Mercenary Band') {
        if (p.gold > 0) { p.gold--; guard.value += 2; mercenaryUsed = true; addLog(room, `${p.name} spends 1 gold on mercenaries: 2 guards.`); }
        else addLog(room, `${p.name} cannot afford a Mercenary Band.`);
      } else if (action.card === 'Guild Investment') {
        if (p.gold >= 2) { p.gold -= 2; room.investments.push({ player: p.id, due: room.round + 1, amount: 4 }); addLog(room, `${p.name} invests 2 gold in the guild for 4 next round.`); }
        else addLog(room, `${p.name} cannot afford a Guild Investment.`);
      } else if (action.card === 'Court Censure' && target && target.id !== p.id) {
        if (!isProtected(target, action.card)) {
          const combo = play.actions.some((a) => a.card === 'Blackmail' && a.target === action.target);
          target.influence = Math.max(0, target.influence - (combo ? 2 : 1)); target.gold = Math.max(0, target.gold - 1);
          addLog(room, `${p.name} censures ${target.name}, costing them 1 influence and 1 gold${combo ? ' plus 1 extra influence through the Coercive Audit combo' : ''}.`);
        }
      } else if (action.card === 'Hidden Blade') {
        if (p.id === room.king) { guard.value++; addLog(room, `${p.name} uses a Hidden Blade to add 1 guard.`); }
        else { yesBonus.value++; addLog(room, `${p.name} readies a Hidden Blade (+1 support if a plot begins).`); }
      } else if (action.card === 'Pilgrim’s Alms') {
        if (p.gold <= 5) { p.gold += 2; addLog(room, `${p.name} receives 2 gold in Pilgrim’s Alms.`); }
        else { const gained = gainInfluence(p); addLog(room, `${p.name} turns Pilgrim’s Alms into ${gained} influence.`); }
      } else if (action.card === 'Royal Writ' && target && target.id !== p.id) {
        if (!isProtected(target, action.card)) {
          if (target.influence > 0) { target.influence--; const gained = gainInfluence(p); addLog(room, `${p.name} uses a Royal Writ to take 1 influence from ${target.name}${gained ? '' : ', but is already at the influence limit'}.`); }
          else addLog(room, `${p.name} finds no influence to claim with a Royal Writ.`);
        }
      } else if (action.card === 'Poisoned Wine') {
        if (p.gold > 0) {
          p.gold--;
          if (p.id === room.king) { guard.value += 2; addLog(room, `${p.name} spends 1 gold on Poisoned Wine; the poisoned cups add 2 royal guards.`); }
          else { yesBonus.value += 2; addLog(room, `${p.name} spends 1 gold on Poisoned Wine, preparing 2 plot support.`); }
        } else addLog(room, `${p.name} cannot afford Poisoned Wine; it adds no support or guards.`);
      }
    }
    if (play.actions.some((a) => a.card === 'Royal Guard') && mercenaryUsed) {
      guard.value++;
      addLog(room, `${p.name} combines Royal Guard and Mercenary Band for 1 extra guard.`);
    }
  }
  const chancellor = room.players.find((player) => player.office === 'Chancellor');
  if (chancellor) {
    const royalDecree = room.plays[room.king]?.decree;
    const recipient = getById(room, room.plays[chancellor.id]?.officeTarget);
    if (royalDecree === 'Favor the Heir' || royalDecree === 'Favor a Vassal') {
      addLog(room, `The monarch’s Favor decree replaces the Chancellor’s influence grant this turn.`);
    } else if (recipient && recipient.id !== room.king && recipient.id !== chancellor.id) {
      const gained = gainInfluence(recipient);
      addLog(room, `Chancellor ${chancellor.name} grants ${gained} influence to ${recipient.name}.`);
    }
  }
  const hasAssassination = plotters.length || room.event === 'Night of Knives';
  if (hasAssassination) {
    resolvePetitions(false);
    const royalPlay = room.plays[room.king];
    if (royalPlay?.successionCost) {
      const monarch = getById(room, room.king);
      if (monarch) gainInfluence(monarch, royalPlay.successionCost);
      addLog(room, 'The succession decree is interrupted by the assassination vote; its influence cost is returned.');
      royalPlay.successionCost = 0;
    }
    if (royalPlay?.decree === 'Court Appointment') addLog(room, 'The assassination vote interrupts the Court Appointment decree; no office changes hands.');
    const votes = Object.fromEntries(plotters.map((id) => [id, { side: 'yes', weight: getById(room, id)?.office === 'Spymaster' ? 2 : 1 }]));
    room.pendingAssassination = { plotters, votes, guard: guard.value, autoNo: autoNo.value, yesBonus: yesBonus.value };
    if (room.event === 'Night of Knives') addLog(room, 'Night of Knives: a surprise plot begins.');
    beginPactResponses(room, pactOffers, 'assassination');
    if (room.phase === 'assassination' && room.players.every((player) => room.assassination.votes[player.id])) resolveAssassination(room);
    return;
  }
  if (autoNo.value) addLog(room, `Counterplot contributes ${autoNo.value} opposing vote(s).`);
  const monarch = getById(room, room.king);
  const royal = room.plays[room.king];
  const decree = royal?.decree;
  if (decree !== 'Royal Prerogative') resolvePetitions(false);
  if (decree === 'Royal Prerogative') {
    const petitionClaims = resolvePetitions(true);
    const treasurer = room.players.find((player) => player.office === 'Treasurer');
    const recipient = treasurer && getById(room, room.plays[treasurer.id]?.officeTarget);
    if (recipient && recipient.id !== room.king) {
      const remaining = Math.max(0, 3 - petitionClaims);
      const diverted = Math.min(1, remaining);
      monarch.gold += remaining - diverted; recipient.gold += diverted;
      const gained = gainInfluence(monarch);
      addLog(room, `${monarch.name} claims ${remaining - diverted} gold and ${gained} influence under Royal Prerogative; Treasurer ${treasurer.name} diverts ${diverted} gold to ${recipient.name}.`);
    } else {
      const claim = Math.max(0, 3 - petitionClaims);
      monarch.gold += claim; const gained = gainInfluence(monarch);
      addLog(room, `${monarch.name} claims ${claim} gold and ${gained} influence under Royal Prerogative.`);
    }
  }
  else if (decree === 'Favor the Heir') {
    const heir = getById(room, room.heir);
    if (heir) { heir.gold += 2; const gained = gainInfluence(heir); monarch.gold++; addLog(room, `${monarch.name} favors ${heir.name}: +2 gold, +${gained} influence, +1 gold to the crown.`); }
  } else if (decree === 'Favor a Vassal') {
    const vassal = getById(room, royal?.favor);
    if (vassal && vassal.id !== monarch.id) { vassal.gold += 2; const gained = gainInfluence(vassal); monarch.gold++; addLog(room, `${monarch.name} rewards ${vassal.name}: +2 gold, +${gained} influence, +1 gold to the crown.`); }
  } else if (decree === 'Change Succession') {
    const newLaw = royal.successionLaw || room.succession;
    const heir = getById(room, royal.appointedHeir);
    const newHeir = newLaw === 'Appointed Heir' && heir && heir.id !== monarch.id ? heir.id : room.heir;
    const changed = newLaw !== room.succession || (newLaw === 'Appointed Heir' && newHeir !== room.heir);
    if (changed) {
      room.succession = newLaw;
      if (newLaw === 'Appointed Heir') room.heir = newHeir;
      addLog(room, `${monarch.name} spends ${royal.successionCost || 0} influence to change succession to ${room.succession}${room.succession === 'Appointed Heir' ? `, naming ${getById(room, room.heir)?.name}` : ''}.`);
    } else addLog(room, `${monarch.name} keeps succession law ${room.succession}; no influence is spent.`);
  } else if (decree === 'Court Appointment') resolveCourtAppointment(room, royal);
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
function payOfficeSalaries(room) {
  const officers = room.players.filter((player) => player.office);
  if (!officers.length) return;
  const monarch = getById(room, room.king);
  if (!monarch || monarch.gold < officers.length) {
    addLog(room, `The crown cannot afford the ${officers.length} office ${officers.length === 1 ? 'salary' : 'salaries'} this turn.`);
    return;
  }
  for (const officer of officers) {
    monarch.gold--;
    officer.gold++;
    addLog(room, `${officer.name} receives 1 gold as ${officer.office}, paid from the royal treasury.`);
  }
}
function rotateEvent(room) {
  room.round++; room.plays = {}; selectEvent(room); room.phase = 'play';
  room.deadline = Date.now() + 60000; room.pacts = room.pacts.filter((p) => p.expires >= room.round);
  payInvestments(room);
  if (finishIfWon(room)) return;
  payOfficeSalaries(room);
  if (finishIfWon(room)) return;
  for (const player of room.players) draw(player, 2);
  addLog(room, `Round ${room.round}: ${room.event}. The crown remains with ${getById(room, room.king)?.name}.`);
}
function resetToLobby(room) {
  room.phase = 'lobby'; room.round = 0; room.event = null; room.king = null; room.heir = null; room.winner = null;
  room.plays = {}; room.assassination = null; room.successionVote = null; room.deposedKing = null; room.deadline = null;
  room.succession = 'Next in Line'; room.investments = []; room.pacts = []; room.pactOffers = []; room.pactIndex = 0;
  room.afterPacts = null; room.pendingAssassination = null; room.matchLog = null;
  for (const player of room.players) { player.gold = 4; player.influence = 0; player.office = null; player.hand = []; draw(player, 5); }
}
function leaveRoom(room, player) {
  if (room.phase === 'ended') return;
  const leavingId = player.id;
  const wasKing = room.king === leavingId;
  const kingExitDuringPlot = wasKing && room.phase === 'assassination';
  const nextKing = wasKing ? successor(room) : null;
  room.players = room.players.filter((p) => p.id !== leavingId);
  delete room.plays[leavingId];
  room.pacts = room.pacts.filter((p) => p.a !== leavingId && p.b !== leavingId);
  room.investments = room.investments.filter((item) => item.player !== leavingId);
  if (room.host === player.token) room.host = room.players[0]?.token || null;
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.players.length < 2) {
    resetToLobby(room);
    addLog(room, 'Not enough players remain. The court returns to the lobby; invite another vassal to begin again.');
    return;
  }
  if (wasKing) {
    room.king = nextKing;
    room.heir = nextInLine(room, room.king);
    addLog(room, `${player.name} leaves court. ${getById(room, room.king)?.name} inherits the crown.`);
    if (kingExitDuringPlot) {
      room.assassination = null;
      addLog(room, 'The assassination vote ends as the monarch leaves court.');
      rotateEvent(room);
      return;
    }
    if (room.phase === 'pact_response' && room.afterPacts === 'assassination') {
      room.afterPacts = 'round'; room.pendingAssassination = null;
      addLog(room, 'The pending assassination is abandoned after the monarch leaves court.');
    }
  } else addLog(room, `${player.name} leaves court.`);
  if (room.heir === leavingId) room.heir = nextInLine(room, room.king);
  if (room.phase === 'pact_response') {
    room.pactOffers = room.pactOffers.slice(room.pactIndex).filter((offer) =>
      offer.from !== leavingId && offer.to !== leavingId && getById(room, offer.from) && getById(room, offer.to));
    room.pactIndex = 0;
    if (!room.pactOffers.length) continueAfterPacts(room);
  }
  if (room.assassination) {
    delete room.assassination.votes[leavingId];
    room.assassination.plotters = room.assassination.plotters.filter((id) => id !== leavingId);
    if (room.players.every((p) => room.assassination.votes[p.id])) resolveAssassination(room);
  }
  if (room.pendingAssassination) {
    delete room.pendingAssassination.votes[leavingId];
    room.pendingAssassination.plotters = room.pendingAssassination.plotters.filter((id) => id !== leavingId);
  }
  if (room.successionVote) {
    delete room.successionVote.votes[leavingId];
    for (const [voter, vote] of Object.entries(room.successionVote.votes)) if (vote.candidate === leavingId) delete room.successionVote.votes[voter];
    if (room.players.every((p) => room.successionVote.votes[p.id])) resolveCourtVote(room);
  }
  if (room.phase === 'play' && room.players.every((p) => room.plays[p.id])) resolveCards(room);
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
        players: [{ id: randomUUID(), token, name: (data.name || 'Player').slice(0, 16), gold: 4, influence: 0, office: null, hand: [] }],
        king: null, heir: null, target: 30, round: 0, event: null, log: ['Welcome to court. Invite 1–7 rivals with this room code.'], matchLog: null, chat: [],
        plays: {}, succession: 'Next in Line', deadline: null, assassination: null, successionVote: null,
        investments: [], pacts: [], pactOffers: [], pactIndex: 0, afterPacts: null, pendingAssassination: null,
      };
      draw(room.players[0], 5); rooms.set(roomCode, room);
      json(res, { token, state: publicState(room, token) }); return;
    }
    const match = url.pathname.match(/^\/api\/(join|state|start|play|vote|succession|pact|leave|chat|bot)\/([A-Z0-9]+)$/);
    if (match) {
      const [, action, roomCode] = match; const room = rooms.get(roomCode);
      if (!room) { json(res, { error: 'Room not found.' }, 404); return; }
      const data = req.method === 'POST' ? await body(req) : {};
      if (action === 'bot') {
        if (data.token !== room.host) { json(res, { error: 'Only the host can add a courtier.' }, 403); return; }
        if (room.phase !== 'lobby') { json(res, { error: 'Bots can only be added before the game begins.' }, 409); return; }
        if (room.players.length >= 8) { json(res, { error: 'The court is full.' }, 409); return; }
        const botNumber = room.players.filter(p => p.bot).length;
        const name = BOT_NAMES[botNumber % BOT_NAMES.length];
        const bot = { id: randomUUID(), token: null, bot: true, name, gold: 4, influence: 0, office: null, hand: [] };
        draw(bot, 5); room.players.push(bot);
        addLog(room, `${name}, a courtier controlled by the host, joins the court.`);
        json(res, { state: publicState(room, data.token) }); return;
      }
      if (action === 'join') {
        if (room.phase !== 'lobby') { json(res, { error: 'This court has already begun.' }, 409); return; }
        if (room.players.length >= 8) { json(res, { error: 'This court is full.' }, 409); return; }
        const token = randomUUID(); const p = { id: randomUUID(), token, name: (data.name || 'Player').slice(0, 16), gold: 4, influence: 0, office: null, hand: [] };
        draw(p, 5); room.players.push(p); addLog(room, `${p.name} joins the court.`);
        json(res, { token, state: publicState(room, token) }); return;
      }
      const token = data.token || url.searchParams.get('token'); const me = getPlayer(room, token);
      if (!me) { json(res, { error: 'You are not in this room.' }, 403); return; }
      if (action === 'leave') { leaveRoom(room, me); json(res, { ok: true }); return; }
      if (action === 'chat') {
        const message = String(data.message || '').trim();
        if (!message) { json(res, { error: 'Write a message first.' }, 400); return; }
        if (message.length > 240) { json(res, { error: 'Messages can be up to 240 characters.' }, 400); return; }
        room.chat ||= [];
        room.chat.push({ name: me.name, message, at: Date.now() });
        if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'state') { json(res, { state: publicState(room, token) }); return; }
      if (action === 'start') {
        if (token !== room.host) { json(res, { error: 'Only the host can begin the game.' }, 403); return; }
        if (room.players.length < 2) { json(res, { error: 'Invite at least one more player before starting.' }, 400); return; }
        if (room.phase === 'lobby') start(room);
        scheduleBot(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'play') {
        if (room.phase !== 'play') { json(res, { error: 'The court is not taking actions now.' }, 409); return; }
        if (room.plays[me.id]) { json(res, { error: 'Your cards are already committed.' }, 409); return; }
        const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : [];
        if (!actions.length || actions.some((a) => !me.hand.includes(a.card))) { json(res, { error: 'Choose one or two cards from your hand.' }, 400); return; }
        const targetRequired = new Set(['Secret Pact', 'Spy Network', 'Blackmail', 'Court Censure', 'Royal Writ', 'Letters of Protection', 'Petition for Redress']);
        for (const action of actions) {
          const target = getById(room, action.target);
          const monarchTribute = action.card === 'Gold Tribute' && me.id === room.king;
          if (targetRequired.has(action.card) || monarchTribute) {
            if (!target) { json(res, { error: `Choose a valid target for ${action.card}.` }, 400); return; }
            if (action.card === 'Letters of Protection') continue;
            if ((action.card === 'Petition for Redress' || monarchTribute) && target.id === room.king) { json(res, { error: `${action.card} must target a vassal.` }, 400); return; }
            if (target.id === me.id && !['Letters of Protection', 'Petition for Redress'].includes(action.card)) { json(res, { error: `${action.card} must target another player.` }, 400); return; }
          }
          if (action.card === 'King’s Bounty') action.bountySide = action.bountySide === 'no' ? 'no' : 'yes';
        }
        const decree = me.id === room.king ? data.decree : null;
        if (decree && !DECREES.includes(decree)) { json(res, { error: 'Choose a valid royal decree.' }, 400); return; }
        const appointmentAction = data.appointmentAction === 'dismiss' ? 'dismiss' : 'appoint';
        const appointmentRole = data.appointmentRole || null;
        const appointmentTarget = data.appointmentTarget || null;
        if (decree === 'Court Appointment') {
          const target = getById(room, appointmentTarget);
          if (!target || target.id === room.king) { json(res, { error: 'Choose a vassal for the court appointment.' }, 400); return; }
          if (appointmentAction === 'dismiss') {
            if (!target.office) { json(res, { error: 'Choose a current officer to dismiss.' }, 400); return; }
          } else {
            if (!OFFICE_NAMES.includes(appointmentRole)) { json(res, { error: 'Choose a valid court office.' }, 400); return; }
            if (target.office && target.office !== appointmentRole) { json(res, { error: 'A player may hold only one office. Choose a vassal without another office.' }, 400); return; }
            const holder = room.players.find((player) => player.office === appointmentRole);
            if (holder?.id === target.id) { json(res, { error: 'That vassal already holds this office.' }, 400); return; }
            if (!holder && !target.office && room.players.filter((player) => player.office).length >= officeLimit(room.players.length)) { json(res, { error: `This court has room for only ${officeLimit(room.players.length)} officer${officeLimit(room.players.length) === 1 ? '' : 's'}.` }, 400); return; }
          }
        }
        if (me.office === 'Chancellor' || me.office === 'Treasurer') {
          const officeTarget = getById(room, data.officeTarget);
          const targetAllowed = officeTarget && officeTarget.id !== room.king &&
            (me.office === 'Treasurer' || officeTarget.id !== me.id);
          if (!targetAllowed) { json(res, { error: me.office === 'Chancellor' ? 'Choose another vassal for the Chancellor’s grant.' : 'Choose a vassal for the Treasurer’s diversion.' }, 400); return; }
        }
        const successionLaw = data.successionLaw || room.succession;
        if (decree === 'Change Succession' && !LAWS.includes(successionLaw)) { json(res, { error: 'Choose a valid succession law.' }, 400); return; }
        const appointedHeir = data.appointedHeir || null;
        if (decree === 'Change Succession' && successionLaw === 'Appointed Heir' && (!getById(room, appointedHeir) || appointedHeir === me.id)) { json(res, { error: 'Choose a vassal to name as heir.' }, 400); return; }
        const changesSuccession = decree === 'Change Succession' && (
          successionLaw !== room.succession ||
          (successionLaw === 'Appointed Heir' && appointedHeir !== room.heir)
        );
        const successionCost = changesSuccession ? 2 : 0;
        if (successionCost && me.influence < successionCost) { json(res, { error: 'Changing succession costs 2 influence.' }, 400); return; }
        if (successionCost) me.influence -= successionCost;
        for (const a of actions) me.hand.splice(me.hand.indexOf(a.card), 1);
        room.plays[me.id] = {
          actions, decree,
          favor: data.favor || null, successionLaw: data.successionLaw || null,
          appointedHeir, successionCost, appointmentAction, appointmentRole, appointmentTarget,
          officeTarget: data.officeTarget || null,
        };
        addLog(room, `${me.name} commits their cards.`);
        if (room.players.every((p) => room.plays[p.id])) resolveCards(room);
        scheduleBot(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'vote') {
        if (room.phase !== 'assassination') { json(res, { error: 'There is no active plot.' }, 409); return; }
        if (!room.assassination.votes[me.id]) {
          castAssassinationVote(room, me, data.vote, data.spendInfluence);
        }
        if (room.players.every((p) => room.assassination.votes[p.id])) resolveAssassination(room);
        scheduleBot(room);
        json(res, { state: publicState(room, token) }); return;
      }
      if (action === 'pact') {
        if (room.phase !== 'pact_response') { json(res, { error: 'There is no pact waiting for your answer.' }, 409); return; }
        try { answerPact(room, me, Boolean(data.accept)); }
        catch (error) { json(res, { error: error.message }, 403); return; }
        scheduleBot(room);
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
        scheduleBot(room);
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
