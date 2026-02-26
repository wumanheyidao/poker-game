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

app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
    MAX_PLAYERS: 10,
    INITIAL_CHIPS: 10000,
    SMALL_BLIND: 50,
    BIG_BLIND: 100,
    ACTION_TIMEOUT: 10000
};

class PokerGame {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.hostId = null;  // ⭐ 房主 ID
        this.deck = [];
        this.communityCards = [];
        this.pot = 0;
        this.dealerIdx = 0;
        this.currentTurnIdx = 0;
        this.stage = 'waiting';
        this.minBet = CONFIG.BIG_BLIND;
        this.timer = null;
        this.lastAggressorIdx = -1;
        this.bettingRound = 0;
        this.playersActed = [];
    }

    // ⭐ 修改 addPlayer 方法，设置房主
    addPlayer(socketId, name) {
        if (this.players.length >= CONFIG.MAX_PLAYERS) return false;
        
        // 第一个加入的玩家成为房主
        const isHost = this.players.length === 0;
        if (isHost) {
            this.hostId = socketId;
            console.log(`👑 Player ${name} is now the room host`);
        }
        
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
            lastActive: Date.now(),
            isHost: isHost  // ⭐ 标记是否为房主
        });
        this.broadcastState();
        if (this.players.length >= 2 && this.stage === 'waiting') {
            this.startRound();
        }
        return true;
    }

    // ⭐ 添加踢人方法
    kickPlayer(kickerId, targetId) {
        const kicker = this.players.find(p => p.id === kickerId);
        const targetIndex = this.players.findIndex(p => p.id === targetId);
        
        if (!kicker) {
            return { success: false, message: '踢人者不存在' };
        }
        
        if (targetIndex === -1) {
            return { success: false, message: '被踢玩家不存在' };
        }
        
        if (kicker.id !== this.hostId) {
            return { success: false, message: '只有房主可以踢人' };
        }
        
        const target = this.players[targetIndex];
        
        // 不能踢自己
        if (kicker.id === target.id) {
            return { success: false, message: '不能踢自己' };
        }
        
        console.log(`👢 Host ${kicker.name} kicked ${target.name}`);
        
        // 通知被踢玩家
        const targetSocket = Array.from(io.sockets.sockets).find(
            s => s.id === targetId
        );
        if (targetSocket) {
            targetSocket.emit('kicked', { 
                reason: '被房主踢出房间',
                kicker: kicker.name
            });
            targetSocket.disconnect(true);
        }
        
        // 从玩家列表移除
        this.players.splice(targetIndex, 1);
        
        // 如果被踢的是当前行动玩家，切换到下一个
        if (targetIndex === this.currentTurnIdx && this.stage !== 'showdown') {
            this.findNextActivePlayer();
        }
        
        // 如果房主离开了，转移房主给第一个玩家
        if (kicker.id === this.hostId && this.players.length > 0) {
            this.hostId = this.players[0].id;
            this.players[0].isHost = true;
            console.log(`👑 New host: ${this.players[0].name}`);
        }
        
        this.broadcastState();
        
        return { success: true, message: `已踢出玩家 ${target.name}` };
    }s
    
    // ... 其他方法不变 ...
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

    socket.on('kick_player', (data) => {
    // data: { targetId, roomId }
    if (rooms[roomId]) {
        const result = rooms[roomId].kickPlayer(socket.id, data.targetId);
        socket.emit('kick_result', result);
    }
});

socket.on('kicked', () => {
    // 被踢后断开连接
    socket.disconnect(true);
});

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (rooms[roomId]) {
            const game = rooms[roomId];
            const playerIndex = game.players.findIndex(pl => pl.id === socket.id);
            if (playerIndex !== -1) {
                const player = game.players[playerIndex];
                player.status = 'disconnected';
                player.lastActive = Date.now();
                if (playerIndex === game.currentTurnIdx && game.stage !== 'showdown') {
                    clearTimeout(game.timer);
                    player.status = 'folded';
                    game.checkRoundEnd();
                }
                game.broadcastState();
            }
        }
    });

    socket.on('reconnect', () => {
        console.log('User reconnected:', socket.id);
        if (rooms[roomId]) {
            const player = rooms[roomId].players.find(p => p.id === socket.id);
            if (player && player.status === 'disconnected') {
                player.status = 'active';
                rooms[roomId].broadcastState();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});