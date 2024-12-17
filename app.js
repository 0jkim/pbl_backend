import express from 'express'
import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
import { Server } from 'socket.io'
import mediasoup from 'mediasoup'
import dotenv from 'dotenv'
import session from 'express-session'
import multer from 'multer' // 파일 전송

dotenv.config()

const app = express()
const __dirname = path.resolve()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 세션 코드
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninutialized: false,
    cookie: { secure: true }
}))

// 인증서 옵션
const options = {
    key: fs.readFileSync('./webrtc.n-e.kr/privkey1.pem', 'utf-8'),
    cert: fs.readFileSync('./webrtc.n-e.kr/fullchain1.pem', 'utf-8')
};

const httpsServer = https.createServer(options, app)

// 정적 파일 제공 
app.use(express.static(path.join(__dirname, 'public')))

// 회원 정보 저장
const usersFile = path.join(__dirname, 'users.json')

// 로그인 여부 확인 미들웨어
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.username) {
        return next()
    }
    res.redirect('/login')
}

// 로그인 상태 확인 API
app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.username) {
        res.json({ loggedIn: true, username: req.session.username })
    } else {
        res.json({ loggedIn: false })
    }
})

// 메인 페이지
app.get('/', (req, res) => {
    const loggedIn = req.session && req.session.username // 로그인 상태 확인
    const username = req.session?.username || '' // 세션에 저장된 사용자 이름

    res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// 로그인 페이지
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'))
})

// 방 생성 페이지
app.get('/create-room', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'create-room.html'));
});

// 방 참가 페이지
app.get('/join-room', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'join-room.html'));
});

/* 회원가입 요청 처리 */
app.post('/signup', (req, res) => {
    const { username, password } = req.body
    if (!username || !password) {
        return res.status(400).send("아이디와 비밀번호를 입력하세요.")
    }

    // 기존 유저 목록 불러오기
    let users = []
    if (fs.existsSync(usersFile)) {
        const data = fs.readFileSync(usersFile, 'utf-8')
        users = JSON.parse(data);
    }

    // 중복 아이디 확인
    if (users.some(user => user.username === username)) {
        return res.status(400).send('이미 존재하는 아이디입니다.')
    }

    // 새 유저 추가
    users.push({ username, password })
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2))

    res.redirect('/login')
})

// 로그인 요청 처리
app.post('/login', (req, res) => {
    console.log('Request Body:', req.body); // req.body가 어떤 값을 가지는지 출력
    const { username, password } = req.body

    if (!username || !password) {
        return res.status(400).send('아이디와 비밀번호를 입력하세요.')
    }

    if (!fs.existsSync(usersFile)) {
        return res.status(400).send('등록된 유저가 없습니다.')
    }

    const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'))
    const user = users.find(user => user.username === username && user.password === password)

    if (!user) {
        return res.status(401).send('아이디 또는 비밀번호가 올바르지 않습니다.')
    }
    req.session.username = username // 세션에 사용자 정보 저장

    res.redirect('/')
})

const roomInfo = {};
app.post('/create-room', isAuthenticated, (req, res) => {
    const { roomName, password } = req.body;

    if (!roomName || !password) {
        return res.status(400).send('방 이름과 비밀번호를 입력하세요.');
    }

    // 방이 이미 존재하는지 확인
    if (roomInfo[roomName]) {
        return res.status(400).send('이미 존재하는 방 이름입니다.');
    }

    // 방 생성
    roomInfo[roomName] = { password, participants: [] };

    // 방으로 이동
    res.redirect(`/sfu/${roomName}`);
});

// 방 참가 요청 처리
app.post('/join-room', isAuthenticated, (req, res) => {
    const { roomName, password } = req.body;

    if (!roomName || !password) {
        return res.status(400).send('방 이름과 비밀번호를 입력하세요.');
    }

    // 방이 존재하는지 확인
    const room = roomInfo[roomName];
    if (!room) {
        return res.status(404).send('존재하지 않는 방입니다.');
    }

    // 비밀번호 확인
    if (room.password !== password) {
        return res.status(401).send('비밀번호가 올바르지 않습니다.');
    }

    // 방 참가
    room.participants.push(req.session.username);

    // 방으로 이동
    res.redirect(`/sfu/${roomName}`);
});

// 로그아웃 요청 처리
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Failed to destroy session:', err);
            return res.status(500).send('Internal Server Error');
        }
        res.redirect('/'); // 로그아웃 후 메인 페이지로 리다이렉트
    });
});
// 방 페이지 처리
app.get('/sfu/:room', isAuthenticated, (req, res) => {
    const { room } = req.params;

    // 방이 존재하는지 확인
    if (!roomInfo[room]) {
        return res.status(404).send('방이 존재하지 않습니다.');
    }

    // 방 페이지 제공
    res.sendFile(path.join(__dirname, 'public', 'sfu.html'));
});

// 파일 저장 설정 (Multer 사용)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // 파일이 저장될 경로
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname)); // 파일 이름 설정
    }
});

const upload = multer({ storage });

// 파일 업로드 라우트
app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ filePath: `/uploads/${req.file.filename}` });
});
// 정적 파일 제공 (업로드된 파일 접근)
app.use('/uploads', express.static('uploads'));


// HTTPS 서버 시작
httpsServer.listen(443, () => {
    console.log("listening on port 443")
})

const io = new Server(httpsServer)

const connections = io.of('/mediasoup')

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
        }
    }
]

let worker
let rooms = {}          // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}          // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []     // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []      // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []      // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 60000,
        rtcMaxPort: 60100,
    })
    console.log('worker pid ${worker.pid')

    worker.on('died', error => {
        console.error('mediasoup worker has died')
        setTimeout(() => process.exit(1), 10000)
    })

    return worker
}

worker = createWorker()

// connection 부분 추가 
connections.on('connection', async socket => {
    console.log(socket.id)
    socket.emit('connection-success', {
        socketId: socket.id,
    })

    const removeItems = (items, socketId, type) => {
        items.forEach(item => {
            if (item.socketId === socket.id) {
                item[type].close()
            }
        })
        items = items.filter(item => item.socketId !== socket.id)

        return items
    }

    socket.on('disconnect', () => {
        // do some cleanup
        console.log('peer disconnected')
        consumers = removeItems(consumers, socket.id, 'consumer')
        producers = removeItems(producers, socket.id, 'producer')
        transports = removeItems(transports, socket.id, 'transport')

        const { roomName } = peers[socket.id]
        delete peers[socket.id]

        // remove socket from room
        rooms[roomName] = {
            router: rooms[roomName].router,
            peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
        }
    })

    // 방 참가하는 로직 변경해야함 . . . =>
    // 1. 메인 페이지 (webrtc.n-e.kr)는 로그인 이후 방 참가 or 방 생성 페이지로 이동할 수 있음.
    // 2. 방 생성의 경우 방 이름, 방 비밀번호를 입력하면 방 참가 페이지와 동일한 페이지로 이동
    // 3. [1]에서 방 참가 페이지로 이동하면 방 번호와 비밀번호를 입력함.
    // 4. 일치하면 해당 방으로 참여, 실패하면 방 접속 실패 . . .

    socket.on('joinRoom', async ({ roomName }, callback) => {
        // create Router if it does not exist
        // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
        const router1 = await createRoom(roomName, socket.id)

        peers[socket.id] = {
            socket,
            roomName,           // Name for the Router this Peer joined
            transports: [],
            producers: [],
            consumers: [],
            peerDetails: {
                name: '',
                isAdmin: false,   // Is this Peer the Admin?
            }
        }

        // get Router RTP Capabilities
        const rtpCapabilities = router1.rtpCapabilities

        // call callback from the client and send back the rtpCapabilities
        callback({ rtpCapabilities })
    })

    const createRoom = async (roomName, socketId) => {
        // worker.createRouter(options)
        // options = { mediaCodecs, appData }
        // mediaCodecs -> defined above
        // appData -> custom application data - we are not supplying any
        // none of the two are required
        let router1
        let peers = []
        if (rooms[roomName]) {
            router1 = rooms[roomName].router
            peers = rooms[roomName].peers || []
        } else {
            router1 = await worker.createRouter({ mediaCodecs, })
        }

        console.log(`Router ID: ${router1.id}`, peers.length)

        rooms[roomName] = {
            router: router1,
            peers: [...peers, socketId],
        }

        return router1
    }

    // socket.on('createRoom', async (callback) => {
    //   if (router === undefined) {
    //     // worker.createRouter(options)
    //     // options = { mediaCodecs, appData }
    //     // mediaCodecs -> defined above
    //     // appData -> custom application data - we are not supplying any
    //     // none of the two are required
    //     router = await worker.createRouter({ mediaCodecs, })
    //     console.log(`Router ID: ${router.id}`)
    //   }

    //   getRtpCapabilities(callback)
    // })

    // const getRtpCapabilities = (callback) => {
    //   const rtpCapabilities = router.rtpCapabilities

    //   callback({ rtpCapabilities })
    // }

    // Client emits a request to create server side Transport
    // We need to differentiate between the producer and consumer transports
    socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
        // get Room Name from Peer's properties
        const roomName = peers[socket.id].roomName

        // get Router (Room) object this peer is in based on RoomName
        const router = rooms[roomName].router


        createWebRtcTransport(router).then(
            transport => {
                callback({
                    params: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    }
                })

                // add transport to Peer's properties
                addTransport(transport, roomName, consumer)
            },
            error => {
                console.log(error)
            })
    })

    const addTransport = (transport, roomName, consumer) => {

        transports = [
            ...transports,
            { socketId: socket.id, transport, roomName, consumer, }
        ]

        peers[socket.id] = {
            ...peers[socket.id],
            transports: [
                ...peers[socket.id].transports,
                transport.id,
            ]
        }
    }

    const addProducer = (producer, roomName) => {
        producers = [
            ...producers,
            { socketId: socket.id, producer, roomName, }
        ]

        peers[socket.id] = {
            ...peers[socket.id],
            producers: [
                ...peers[socket.id].producers,
                producer.id,
            ]
        }
    }

    const addConsumer = (consumer, roomName) => {
        // add the consumer to the consumers list
        consumers = [
            ...consumers,
            { socketId: socket.id, consumer, roomName, }
        ]

        // add the consumer id to the peers list
        peers[socket.id] = {
            ...peers[socket.id],
            consumers: [
                ...peers[socket.id].consumers,
                consumer.id,
            ]
        }
    }

    socket.on('getProducers', callback => {
        //return all producer transports
        const { roomName } = peers[socket.id]

        let producerList = []
        producers.forEach(producerData => {
            if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
                producerList = [...producerList, producerData.producer.id]
            }
        })

        // return the producer list back to the client
        callback(producerList)
    })

    const informConsumers = (roomName, socketId, id) => {
        console.log(`just joined, id ${id} ${roomName}, ${socketId}`)
        // A new producer just joined
        // let all consumers to consume this producer
        producers.forEach(producerData => {
            if (producerData.socketId !== socketId && producerData.roomName === roomName) {
                console.log(123)
                const producerSocket = peers[producerData.socketId].socket
                // use socket to send producer id to producer
                producerSocket.emit('new-producer', { producerId: id })
            }
        })
    }

    const getTransport = (socketId) => {
        const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
        return producerTransport.transport
    }

    // see client's socket.emit('transport-connect', ...)
    socket.on('transport-connect', ({ dtlsParameters }) => {
        console.log('DTLS PARAMS... ', { dtlsParameters })

        getTransport(socket.id).connect({ dtlsParameters })
    })

    // see client's socket.emit('transport-produce', ...)
    socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
        // call produce based on the prameters from the client
        const producer = await getTransport(socket.id).produce({
            kind,
            rtpParameters,
        })

        // add producer to the producers array
        const { roomName } = peers[socket.id]

        addProducer(producer, roomName)

        informConsumers(roomName, socket.id, producer.id)

        console.log('Producer ID: ', producer.id, producer.kind)

        producer.on('transportclose', () => {
            console.log('transport for this producer closed ')
            producer.close()
        })

        // Send back to the client the Producer's id
        callback({
            id: producer.id,
            producersExist: producers.length > 1 ? true : false
        })
    })

    // see client's socket.emit('transport-recv-connect', ...)
    socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
        console.log(`DTLS PARAMS: ${dtlsParameters}`)
        const consumerTransport = transports.find(transportData => (
            transportData.consumer && transportData.transport.id == serverConsumerTransportId
        )).transport
        await consumerTransport.connect({ dtlsParameters })
    })

    socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
        try {

            const { roomName } = peers[socket.id]
            const router = rooms[roomName].router
            let consumerTransport = transports.find(transportData => (
                transportData.consumer && transportData.transport.id == serverConsumerTransportId
            )).transport

            // check if the router can consume the specified producer
            if (router.canConsume({
                producerId: remoteProducerId,
                rtpCapabilities
            })) {
                // transport can now consume and return a consumer
                const consumer = await consumerTransport.consume({
                    producerId: remoteProducerId,
                    rtpCapabilities,
                    paused: true,
                })

                consumer.on('transportclose', () => {
                    console.log('transport close from consumer')
                })

                consumer.on('producerclose', () => {
                    console.log('producer of consumer closed')
                    socket.emit('producer-closed', { remoteProducerId })

                    consumerTransport.close([])
                    transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id)
                    consumer.close()
                    consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id)
                })

                addConsumer(consumer, roomName)

                // from the consumer extract the following params
                // to send back to the Client
                const params = {
                    id: consumer.id,
                    producerId: remoteProducerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    serverConsumerId: consumer.id,
                }

                // send the parameters to the client
                callback({ params })
            }
        } catch (error) {
            console.log(error.message)
            callback({
                params: {
                    error: error
                }
            })
        }
    })

    socket.on('consumer-resume', async ({ serverConsumerId }) => {
        console.log('consumer resume')
        const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId)
        await consumer.resume()
    })

    socket.on('sendMessage', (data) => {
        // 본인 외의 다른 모든 클라이언트에게 메시지 전송
        const {user_name, message} = data
        console.log(user_name)
        socket.broadcast.emit('receiveMessage', {user_name:user_name, message:message});
        console.log("Message from ${socket.id}: ${message}");
    });

    // 파일 전송
    socket.on('sendFile', (data) => {
        const {user_name, fileName, filePath} = data;
        console.log("test",fileName, filePath)
        // 본인 외의 다른 모든 클라이언트에게 파일 정보 전송
        socket.broadcast.emit('receiveFile', {user_name:user_name, fileName:fileName, filePath:filePath});
        console.log("File from ${socket.id}: ${fileInfo.fileName} at ${fileInfo.filePath}");
    });
})

const createWebRtcTransport = async (router) => {
    return new Promise(async (resolve, reject) => {
        try {
            // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
            const webRtcTransport_options = {
                listenIps: [
                    {
                        ip: '0.0.0.0', // replace with relevant IP address
                        announcedIp: '117.16.153.134',
                    }
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            }

            // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
            let transport = await router.createWebRtcTransport(webRtcTransport_options)
            console.log(`transport id: ${transport.id}`)

            transport.on('dtlsstatechange', dtlsState => {
                if (dtlsState === 'closed') {
                    transport.close()
                }
            })

            transport.on('close', () => {
                console.log('transport closed')
            })

            resolve(transport)

        } catch (error) {
            reject(error)
        }
    })
}