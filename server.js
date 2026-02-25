const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PokerSolver = require('pokersolver');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静态文件目录
app.use(express.static(path.join(__dirname, 'public')));

// 游戏配置
const CONFIG = {
    MAX_PLAYERS: 10,
    INITIAL_CHIPS: 10000,
    SMALL_BLIND: 50,
    BIG_BLIND: 100,
    ACTION_TIMEOUT: 10000
};

// 游戏房间类
class PokerGame {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.deck = [];
        this.communityCards = [];
        this.pot = 0;
        this.dealerIdx = 0;
        this.currentTurnIdx = 0;
        this.stage = 'waiting'; // waiting, preflop, flop, turn, river, showdown
        this.minBet = CONFIG.BIG_BLIND;
        this.timer = null;
    }

    // 加入玩家
    addPlayer(socketId, name) {
        if (this.players.length >= CONFIG.MAX_PLAYERS) return false;
        this.players.push({
            id: socketId,
            name: name || `Player ${this.players.length + 1}`,
            chips: CONFIG.INITIAL_CHIPS,
            hand: [],
            status: 'active',
            currentBet: 0,
            isDealer: false,
            isSmallBlind: false,
            isBigBlind: false
        });
        this.broadcastState();
        if (this.players.length >= 2 && this.stage === 'waiting') {
            this.startRound();
        }
        return true;
    }

    // 创建并洗牌
    createDeck() {
        const suits = ['s', 'h', 'c', 'd'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
        this.deck = [];
        for (let s of suits) {
            for (let v of values) {
                this.deck.push({ suit: s, value: v });
            }
        }
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    // 开始新的一局
    startRound() {
        if (this.players.filter(p => p.chips > 0).length < 2) return;
        this.stage = 'preflop';
        this.communityCards = [];
        this.pot = 0;
        this.createDeck();
        
        this.players.forEach(p => {
            if (p.chips > 0) {
                p.hand = [];
                p.status = 'active';
                p.currentBet = 0;
                p.isDealer = false;
                p.isSmallBlind = false;
                p.isBigBlind = false;
            } else {
                p.status = 'sitout';
            }
        });

        const activePlayers = this.players.filter(p => p.status !== 'sitout');
        if (activePlayers.length < 2) return;

        this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
        let sbIdx = (this.dealerIdx + 1) % this.players.length;
        let bbIdx = (this.dealerIdx + 2) % this.players.length;

        this.postBlind(sbIdx, CONFIG.SMALL_BLIND, 'isSmallBlind');
        this.postBlind(bbIdx, CONFIG.BIG_BLIND, 'isBigBlind');

        for (let i = 0; i < 2; i++) {
            this.players.forEach(p => {
                if (p.status === 'active') p.hand.push(this.deck.pop());
            });
        }

        this.currentTurnIdx = (bbIdx + 1) % this.players.length;
        this.broadcastState();
        this.nextTurn();
    }

    // 下盲注
    postBlind(playerIdx, amount, flag) {
        const p = this.players[playerIdx];
        if (p.chips >= amount) {
            p.chips -= amount;
            p.currentBet = amount;
            this.pot += amount;
            p[flag] = true;
        } else {
            this.pot += p.chips;
            p.currentBet = p.chips;
            p.chips = 0;
            p[flag] = true;
        }
    }

    // 处理玩家动作
    handleAction(socketId, action) {
        const player = this.players.find(p => p.id === socketId);
        if (!player || player.id !== this.players[this.currentTurnIdx].id || player.status !== 'active') return;

        clearTimeout(this.timer);

        if (action === 'fold') {
            player.status = 'folded';
        } else if (action === 'check' || action === 'call') {
            const toCall = this.minBet - player.currentBet;
            if (toCall > 0) {
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay;
                player.currentBet += pay;
                this.pot += pay;
            }
        } else if (action === 'raise') {
            const raiseAmt = this.minBet;
            if (player.chips >= raiseAmt) {
                player.chips -= raiseAmt;
                player.currentBet += raiseAmt;
                this.pot += raiseAmt;
                this.minBet += raiseAmt;
            }
        }

        this.checkRoundEnd();
    }

    // 检查本轮是否结束
    checkRoundEnd() {
        const activePlayers = this.players.filter(p => p.status === 'active');
        if (activePlayers.length === 1) {
            this.settleWinner(activePlayers);
            return;
        }
        this.nextStage();
    }

    // 进入下一阶段
    nextStage() {
        this.players.forEach(p => p.currentBet = 0);
        this.minBet = CONFIG.BIG_BLIND;

        if (this.stage === 'preflop') {
            this.stage = 'flop';
            this.deck.pop();
            this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        } else if (this.stage === 'flop') {
            this.stage = 'turn';
            this.deck.pop();
            this.communityCards.push(this.deck.pop());
        } else if (this.stage === 'turn') {
            this.stage = 'river';
            this.deck.pop();
            this.communityCards.push(this.deck.pop());
        } else if (this.stage === 'river') {
            this.stage = 'showdown';
            this.settleShowdown();
            return;
        }

        this.findNextActivePlayer();
        this.broadcastState();
        this.nextTurn();
    }

    // 找下一个活跃玩家
    findNextActivePlayer() {
        let idx = (this.dealerIdx + 1) % this.players.length;
        while (this.players[idx].status !== 'active') {
            idx = (idx + 1) % this.players.length;
        }
        this.currentTurnIdx = idx;
    }

    // 轮到下一个玩家
    nextTurn() {
        if (this.stage === 'showdown') return;
        const currentPlayer = this.players[this.currentTurnIdx];
        io.to(currentPlayer.id).emit('your_turn');
        this.timer = setTimeout(() => {
            this.handleAction(currentPlayer.id, 'check');
        }, CONFIG.ACTION_TIMEOUT);
    }

    // 摊牌比牌
    settleShowdown() {
        const activePlayers = this.players.filter(p => p.status === 'active');
        let bestRank = -1;
        let winners = [];

        activePlayers.forEach(p => {
            const allCards = [
                ...p.hand.map(c => c.value + c.suit),
                ...this.communityCards.map(c => c.value + c.suit)
            ];
            try {
                const hand = PokerSolver.Hand.solve(allCards);
                if (hand.rankValue > bestRank) {
                    bestRank = hand.rankValue;
                    winners = [p];
                } else if (hand.rankValue === bestRank) {
                    winners.push(p);
                }
            } catch (e) {
                console.error("Hand solve error", e);
            }
        });

        const winAmount = Math.floor(this.pot / winners.length);
        winners.forEach(w => {
            w.chips += winAmount;
            io.to(w.id).emit('game_result', { 
                msg: `你赢了！获得 ${winAmount} 筹码`, 
                handName: PokerSolver.Hand.solve([
                    ...w.hand.map(c => c.value + c.suit), 
                    ...this.communityCards.map(c => c.value + c.suit)
                ]).name 
            });
        });

        this.broadcastState();
        setTimeout(() => {
            this.startRound();
        }, 5000);
    }

    // 其他人弃牌直接获胜
    settleWinner(winners) {
        winners.forEach(w => {
            w.chips += this.pot;
            io.to(w.id).emit('game_result', { msg: `其他人弃牌，你赢了！获得 ${this.pot} 筹码` });
        });
        this.broadcastState();
        setTimeout(() => this.startRound(), 5000);
    }

    // 广播游戏状态
    broadcastState() {
        const state = {
            stage: this.stage,
            pot: this.pot,
            communityCards: this.communityCards,
            dealerIdx: this.dealerIdx,
            currentTurnIdx: this.currentTurnIdx,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                status: p.status,
                isDealer: p.isDealer,
                isSmallBlind: p.isSmallBlind,
                isBigBlind: p.isBigBlind,
                hand: p.hand
            }))
        };
        io.to(this.roomId).emit('game_state', state);
    }
}

const rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const roomId = socket.handshake.query.roomId || 'room1';
    socket.join(roomId);

    if (!rooms[roomId]) {
        rooms[roomId] = new PokerGame(roomId);
    }

    socket.on('join_game', (name) => {
        rooms[roomId].addPlayer(socket.id, name);
    });

    socket.on('action', (action) => {
        if (rooms[roomId]) {
            rooms[roomId].handleAction(socket.id, action);
        }
    });

    socket.on('disconnect', () => {
        if (rooms[roomId]) {
            const p = rooms[roomId].players.find(pl => pl.id === socket.id);
            if (p) p.status = 'folded';
            rooms[roomId].broadcastState();
        }
    });
});

server.listen(3000, () => {
    console.log('🎰 服务器运行在 http://localhost:3000');
    console.log('📡 按 Ctrl+C 停止服务器');
});