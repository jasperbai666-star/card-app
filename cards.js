/** Card ranks high → low. Joker big > Joker small > K > … > A */
const RANKS = [
  { id: 'joker_big', label: '大王', level: 15, isJoker: true },
  { id: 'joker_small', label: '小王', level: 14, isJoker: true },
  { id: 'K', label: 'K', level: 13 },
  { id: 'Q', label: 'Q', level: 12 },
  { id: 'J', label: 'J', level: 11 },
  { id: '10', label: '10', level: 10 },
  { id: '9', label: '9', level: 9 },
  { id: '8', label: '8', level: 8 },
  { id: '7', label: '7', level: 7 },
  { id: '6', label: '6', level: 6 },
  { id: '5', label: '5', level: 5 },
  { id: '4', label: '4', level: 4 },
  { id: '3', label: '3', level: 3 },
  { id: '2', label: '2', level: 2 },
  { id: 'A', label: 'A', level: 1 },
];

const SUITS = [
  { id: 'spade', symbol: '♠', color: 'black', label: '黑桃' },
  { id: 'heart', symbol: '♥', color: 'red', label: '红心' },
  { id: 'club', symbol: '♣', color: 'black', label: '梅花' },
  { id: 'diamond', symbol: '♦', color: 'red', label: '方块' },
];

function getRank(id) {
  return RANKS.find((r) => r.id === id) || null;
}

function getSuit(id) {
  return SUITS.find((s) => s.id === id) || null;
}

function levelOf(rankId) {
  const r = getRank(rankId);
  return r ? r.level : 0;
}

function validateCard(rankId, suitId) {
  const rank = getRank(rankId);
  if (!rank) return { ok: false, error: '无效的牌面等级' };
  if (rank.isJoker) {
    return { ok: true, rank, suit: null };
  }
  const suit = getSuit(suitId);
  if (!suit) return { ok: false, error: '请选择花色' };
  return { ok: true, rank, suit };
}

function publicCard(rankId, suitId) {
  if (!rankId) return null;
  const rank = getRank(rankId);
  if (!rank) return null;
  if (rank.isJoker) {
    return {
      rank: rank.id,
      label: rank.label,
      level: rank.level,
      isJoker: true,
      suit: null,
      symbol: rank.id === 'joker_big' ? '🃏' : '🂿',
      color: rank.id === 'joker_big' ? 'gold' : 'silver',
    };
  }
  const suit = getSuit(suitId);
  return {
    rank: rank.id,
    label: rank.label,
    level: rank.level,
    isJoker: false,
    suit: suit ? suit.id : null,
    symbol: suit ? suit.symbol : '?',
    color: suit ? suit.color : 'black',
    suitLabel: suit ? suit.label : '',
  };
}

module.exports = { RANKS, SUITS, getRank, getSuit, levelOf, validateCard, publicCard };
