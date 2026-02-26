const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PokerSolver = require('pokersolver');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 静态文件目�?
app.use(express.static(path.join(__dirname, 'public')));

// 游戏配置
const CONFIG = {
    MAX_PLAYERS: 10,
    INITIAL_CHIPS: 10000,
    SMALL_BLIND: 50,
    BIG_BLIND: 100,
    ACTION_TIMEOUT: 10000
};

// 游戏房间�?
class PokerGame {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.deck = [];
        this.communityCards = [];
        this.pot = 0;
        this.dealerIdx = 0;
        this.currentTurnIdx = 0;
        this.stage = 'waiting';
        this.minBet = CONFIG.BIG_BLIND;
        this.timer = null;
        
        // 下注轮次跟踪
        this.lastAggressorIdx = -1;
        this.bettingRound = 0;
        this.playersActed = [];
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
            isBigBlind: false,
            lastActive: Date.now()
        });
        this.broadcastState();
        if (this.players.length >= 2 && this.stage === 'waiting') {
            this.startRound();
        }
        return true;
    }

    // 创建并洗�?
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

    // 清理离线玩家
    cleanupDisconnectedPlayers() {
        const now = Date.now();
        const TIMEOUT = 5 * 60 * 1000; // 5 分钟
        
        this.players = this.players.filter(p => {
            if (p.status === 'disconnected') {
                if (now - p.lastActive > TIMEOUT) {
                    console.log(`🗑�?Player ${p.name} removed (timeout)`);
                    return false;
                }
                return true;
            }
            return true;
        });
    }

    // 开始新的一局
    startRound() {
        // 清理离线玩家
        this.cleanupDisconnectedPlayers();
        
        if (this.players.filter(p => p.chips > 0).length < 2) return;
        
        this.stage = 'preflop';
        this.communityCards = [];
        this.pot = 0;
        this.minBet = CONFIG.BIG_BLIND;
        this.bettingRound = 0;
        this.lastAggressorIdx = -1;
        this.playersActed = [];
        this.createDeck();
        
        this.players.forEach(p => {
            if (p.chips > 0) {
                p.hand = [];
                p.status = 'active';
                p.currentBet: 0;
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

    // 下盲�?
    postBlind(playerIdx, amount, flag) {
        const p = this.players[playerIdx];
        if (!p) return;
        
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
        if (!player || player.id !== this.players[this.currentTurnIdx]?.id || player.status !== 'active') {
            console.log('�?Invalid action:', socketId, 'current:', this.players[this.currentTurnIdx]?.id);
            return;
        }

        clearTimeout(this.timer);
        console.log(`🎮 Player ${player.name} action: ${action}`);

        if (action === 'fold') {
            player.status = 'folded';
            player.currentBet: 0;
        } else if (action === 'check' || action === 'call') {
            const toCall = this.minBet - player.currentBet;
            if (toCall > 0) {
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay;
                player.currentBet += pay;
                this.pot += pay;
            }
        } else if (action === 'raise') {
            const raiseAmt = CONFIG.BIG_BLIND;
            if (player.chips >= raiseAmt) {
                player.chips -= raiseAmt;
                player.currentBet += raiseAmt;
                this.pot += raiseAmt;
                this.minBet = player.currentBet;
                this.lastAggressorIdx = this.currentTurnIdx;
            }
        }

        // 标记该玩家已行动
        if (!this.playersActed.includes(this.currentTurnIdx)) {
            this.playersActed.push(this.currentTurnIdx);
        }

        console.log('📋 Players acted:', this.playersActed, 'Last aggressor:', this.lastAggressorIdx);
        
        this.checkRoundEnd();
    }

    // 检查本轮是否结�?
    checkRoundEnd() {
        const activePlayers = this.players.filter(p => p.status === 'active');
        
        // 只剩一人，直接获胜
        if (activePlayers.length === 1) {
            this.settleWinner(activePlayers);
            return;
        }
        
        // 检查是否所有活跃玩家都已行�?
        const allActed = activePlayers.every(p => {
            const idx = this.players.indexOf(p);
            return this.playersActed.includes(idx);
        });
        
        // 检查是否所有玩家下注额一�?
        const betsMatch = activePlayers.every(p => p.currentBet === this.minBet || p.chips === 0);
        
        console.log(`�?All acted: ${allActed}, Bets match: ${betsMatch}`);
        
        // 只有所有人都行动过且下注一致，才能进入下一阶段
        if (allActed && betsMatch) {
            this.nextStage();
        } else {
            this.nextTurn();
        }
    }

    // 进入下一阶段
    nextStage() {
        console.log('=== 🔄 Next Stage ===');
        
        this.players.forEach(p => p.currentBet: 0);
        this.minBet = CONFIG.BIG_BLIND;
        this.playersActed = [];
        this.lastAggressorIdx = -1;
        this.bettingRound++;

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

        console.log(`📍 Stage: ${this.stage}, Community cards: ${this.communityCards.length}`);
        
        this.findNextActivePlayer();
        this.broadcastState();
        this.nextTurn();
    }

    // 找下一个活跃玩�?
    findNextActivePlayer() {
        let idx = (this.dealerIdx + 1) % this.players.length;
        while (this.players[idx].status !== 'active') {
            idx = (idx + 1) % this.players.length;
        }
        this.currentTurnIdx = idx;
    }

    // 轮到下一个玩�?
    nextTurn() {
        if (this.stage === 'showdown') return;
        
        let nextIdx = (this.currentTurnIdx + 1) % this.players.length;
        let loops = 0;
        
        while (this.players[nextIdx].status !== 'active' && loops < this.players.length) {
            nextIdx = (nextIdx + 1) % this.players.length;
            loops++;
        }
        
        if (loops >= this.players.length) {
            console.log('⚠️ No active players found!');
            return;
        }
        
        this.currentTurnIdx = nextIdx;
        const currentPlayer = this.players[this.currentTurnIdx];
        
        console.log(`👉 Next turn: ${currentPlayer.name} (idx: ${this.currentTurnIdx})`);
        
        io.to(currentPlayer.id).emit('your_turn');
        this.broadcastState();
        
        this.timer = setTimeout(() => {
            console.log(`�?Timeout for ${currentPlayer.name}, auto-check`);
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

    // 其他人弃牌直接获�?
    settleWinner(winners) {
        winners.forEach(w => {
            w.chips += this.pot;
            io.to(w.id).emit('game_result', { msg: `其他人弃牌，你赢了！获得 ${this.pot} 筹码` });
        });
        this.broadcastState();
        setTimeout(() => this.startRound(), 5000);
    }

    // 广播游戏状�?
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
    console.log('🔌 User connected:', socket.id);
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
        console.log('🔌 User disconnected:', socket.id);
        
        if (rooms[roomId]) {
            const game = rooms[roomId];
            const playerIndex = game.players.findIndex(pl => pl.id === socket.id);
            
            if (playerIndex !== -1) {
                const player = game.players[playerIndex];
                console.log(`👤 Player ${player.name} disconnected, chips: ${player.chips}`);
                
                player.status = 'disconnected';
                player.lastActive = Date.now();
                
                // 如果断线的是当前行动玩家，自动弃�?
                if (playerIndex === game.currentTurnIdx && game.stage !== 'showdown') {
                    console.log('⚠️ Current player disconnected, auto-fold');
                    clearTimeout(game.timer);
                    player.status = 'folded';
                    game.checkRoundEnd();
                }
                
                game.broadcastState();
                
                const activePlayers = game.players.filter(p => 
                    p.status === 'active' || (p.status === 'disconnected' && p.chips > 0)
                );
                
                if (activePlayers.length === 0) {
                    game.stage = 'waiting';
                    game.broadcastState();
                }
            }
        }
    });

    socket.on('reconnect', () => {
        console.log('🔌 User reconnected:', socket.id);
        if (rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            if (player && player.status === 'disconnected') {
                player.status = 'active';
                console.log(`�?Player ${player.name} reconnected`);
                rooms[roomId].broadcastState();
            }
        }
    });
});

// 使用环境变量端口（支�?Render 部署�?
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('🎰 服务器运行在 http://localhost:' + PORT);
    console.log('📡 �?Ctrl+C 停止服务�?);
    console.log('🌐 本地访问：http://localhost:' + PORT);
});
