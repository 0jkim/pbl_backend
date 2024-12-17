const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client') // 미디어 수프

const roomName = window.location.pathname.split('/')[2]

const socket = io("/mediasoup")

socket.on("connection-success", ({ socketId }) => {
  console.log(socketId)
  getLocalStream()
})

let device
let rtpCapabilities
let producerTransport
let consumerTransports = []
let audioProducer
let videoProducer
let consumer
let isProducer = false

let params = {
  // mediasoup 
  encodings: [
    {
      rid: 'r0',
      maxBitrate: 100000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r1',
      maxBitrate: 300000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r2',
      maxBitrate: 900000,
      scalabilityMode: 'S1T3',
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000
  }
}

let audioParams;
let videoParams = { params };
let consumingTransports = [];

const streamSuccess = (stream) => {
  localVideo.srcObject = stream

  audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
  videoParams = { track: stream.getVideoTracks()[0], ...videoParams };

  joinRoom()
}

const joinRoom = () => {
  socket.emit('joinRoom', { roomName }, (data) => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)
    // we assign to local variable and will be used when
    // loading the client Device (see createDevice above)
    rtpCapabilities = data.rtpCapabilities

    // once we have rtpCapabilities from the Router, create Device
    createDevice()
  })
}

const getLocalStream = () => {
  navigator.mediaDevices.getUserMedia({
    audio: true,
      video: {
    width: { ideal: 320 }, // 권장 너비
    height: { ideal: 240 } // 권장 높이
  }
    
  })
    .then(streamSuccess)
    .catch(error => {
      console.log(error.message)
    })
}

// A device is an endpoint connecting to a Router on the
// server side to send/recive media
const createDevice = async () => {
  try {
    device = new mediasoupClient.Device()

    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
    // Loads the device with RTP capabilities of the Router (server side)
    await device.load({
      // see getRtpCapabilities() below
      routerRtpCapabilities: rtpCapabilities
    })

    console.log('Device RTP Capabilities', device.rtpCapabilities)

    // once the device loads, create transport
    createSendTransport()

  } catch (error) {
    console.log(error)
    if (error.name === 'UnsupportedError')
      console.warn('browser not supported')
  }
}

const createSendTransport = () => {
  // see server's socket.on('createWebRtcTransport', sender?, ...)
  // this is a call from Producer, so sender = true
  socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
    // The server sends back params needed 
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error)
      return
    }

    console.log(params)

    // creates a new WebRTC Transport to send media
    // based on the server's producer transport params
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
    producerTransport = device.createSendTransport(params)

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-connect', ...)
        await socket.emit('transport-connect', {
          dtlsParameters,
        })

        // Tell the transport that parameters were transmitted.
        callback()

      } catch (error) {
        errback(error)
      }
    })

    producerTransport.on('produce', async (parameters, callback, errback) => {
      console.log(parameters)

      try {
        // tell the server to create a Producer
        // with the following parameters and produce
        // and expect back a server side producer id
        // see server's socket.on('transport-produce', ...)
        await socket.emit('transport-produce', {
          kind: parameters.kind,
          rtpParameters: parameters.rtpParameters,
          appData: parameters.appData,
        }, ({ id, producersExist }) => {
          // Tell the transport that parameters were transmitted and provide it with the
          // server side producer's id.
          callback({ id })

          // if producers exist, then join room
          if (producersExist) getProducers()
        })
      } catch (error) {
        errback(error)
      }
    })

    connectSendTransport()
  })
}

const connectSendTransport = async () => {
  // we now call produce() to instruct the producer transport
  // to send media to the Router
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
  // this action will trigger the 'connect' and 'produce' events above

  audioProducer = await producerTransport.produce(audioParams);
  videoProducer = await producerTransport.produce(videoParams);

  audioProducer.on('trackended', () => {
    console.log('audio track ended')

    // close audio track
  })

  audioProducer.on('transportclose', () => {
    console.log('audio transport ended')

    // close audio track
  })

  videoProducer.on('trackended', () => {
    console.log('video track ended')

    // close video track
  })

  videoProducer.on('transportclose', () => {
    console.log('video transport ended')

    // close video track
  })
}

const signalNewConsumerTransport = async (remoteProducerId) => {
  //check if we are already consuming the remoteProducerId
  if (consumingTransports.includes(remoteProducerId)) return;
  consumingTransports.push(remoteProducerId);

  await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
    // The server sends back params needed 
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error)
      return
    }
    console.log(`PARAMS... ${params}`)

    let consumerTransport
    try {
      consumerTransport = device.createRecvTransport(params)
    } catch (error) {
      // exceptions: 
      // {InvalidStateError} if not loaded
      // {TypeError} if wrong arguments.
      console.log(error)
      return
    }

    consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-recv-connect', ...)
        await socket.emit('transport-recv-connect', {
          dtlsParameters,
          serverConsumerTransportId: params.id,
        })

        // Tell the transport that parameters were transmitted.
        callback()
      } catch (error) {
        // Tell the transport that something was wrong
        errback(error)
      }
    })

    connectRecvTransport(consumerTransport, remoteProducerId, params.id)
  })
}

// server informs the client of a new producer just joined
socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))

const getProducers = () => {
  socket.emit('getProducers', producerIds => {
    console.log(producerIds)
    // for each of the producer create a consumer
    // producerIds.forEach(id => signalNewConsumerTransport(id))
    producerIds.forEach(signalNewConsumerTransport)
  })
}

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
  // for consumer, we need to tell the server first
  // to create a consumer based on the rtpCapabilities and consume
  // if the router can consume, it will send back a set of params as below
  await socket.emit('consume', {
    rtpCapabilities: device.rtpCapabilities,
    remoteProducerId,
    serverConsumerTransportId,
  }, async ({ params }) => {
    if (params.error) {
      console.log('Cannot Consume')
      return
    }

    console.log(`Consumer Params ${params}`)
    // then consume with the local consumer transport
    // which creates a consumer
    const consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters
    })

    consumerTransports = [
      ...consumerTransports,
      {
        consumerTransport,
        serverConsumerTransportId: params.id,
        producerId: remoteProducerId,
        consumer,
      },
    ]

    // create a new div element for the new consumer media
    const newElem = document.createElement('div')
    newElem.setAttribute('id', `td-${remoteProducerId}`)

    if (params.kind == 'audio') {
      //append to the audio container
      newElem.innerHTML = '<audio id="' + remoteProducerId + '" autoplay></audio>'
    } else {
      console.log("video 출력")
      //append to the video container
      newElem.setAttribute('id', 'remoteVideo')
      newElem.innerHTML = '<video id="' + remoteProducerId + '" autoplay id="video" ></video>'
    }

    videoContainer.appendChild(newElem)
    
    // destructure and retrieve the video track from the producer
    const { track } = consumer

    document.getElementById(remoteProducerId).srcObject = new MediaStream([track])

    // the server consumer started with media paused
    // so we need to inform the server to resume

    //updateGridLayout();
    socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId })
  })
}

socket.on('producer-closed', ({ remoteProducerId }) => {
  // server notification is received when a producer is closed
  // we need to close the client-side consumer and associated transport
  const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
  producerToClose.consumerTransport.close()
  producerToClose.consumer.close()

  // remove the consumer transport from the list
  consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)

  // remove the video div element
  // videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`))
  const videoElement = document.getElementById(remoteProducerId);
  console.log(videoElement)
  const parentElement = videoElement.closest('div')
  videoContainer.removeChild(parentElement)
})

const toggleCameraButton = document.getElementById('toggleCamera');
const toggleMicrophoneButton = document.getElementById('toggleMicrophone');

// 토글 상태를 위한 변수
let isCameraEnabled = true;
let isMicrophoneEnabled = true;

// 카메라 토글 버튼 클릭 이벤트
toggleCameraButton.addEventListener('click', () => {
  if (videoParams && videoParams.track) {
    isCameraEnabled = !isCameraEnabled;
    videoParams.track.enabled = isCameraEnabled;

    // 버튼 스타일 업데이트
    toggleCameraButton.classList.toggle("off", !isCameraEnabled);
  }
});

// 마이크 토글 버튼 클릭 이벤트
toggleMicrophoneButton.addEventListener('click', () => {
  if (audioParams && audioParams.track) {
    isMicrophoneEnabled = !isMicrophoneEnabled;
    audioParams.track.enabled = isMicrophoneEnabled;

    // 버튼 스타일 업데이트
    toggleMicrophoneButton.classList.toggle("off", !isMicrophoneEnabled);
  }
});

function updateGridLayout() {
  const videoElements = document.querySelectorAll("#videoContainer > div");
  const totalVideos = videoElements.length;

  const columns = Math.ceil(Math.sqrt(totalVideos));
  const rows = Math.ceil(totalVideos / columns);

  videoContainer.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  videoContainer.style.gridTemplateRows = `repeat(${rows}, auto)`;

  // 비디오 간 간격 및 정렬 유지
  videoContainer.style.gap = "10px";
  videoContainer.style.justifyItems = "center";
  videoContainer.style.alignItems = "center";
}

// 채팅 및 파일
// 파일 전송 버튼 클릭 시 파일 선택 창 열기
document.getElementById('fileButton').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

// 파일 선택 후 파일 전송
document.getElementById('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (file) {
    const formData = new FormData();
    formData.append('file', file);

    // 파일 서버로 업로드
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    const filePath = data.filePath;
    socket.emit('sendFile', { user_name:user_name, fileName: file.name, filePath:filePath });
    addFileLinkToChat('You', file.name, filePath); // 본인이 보낸 파일을 즉시 추가
  }
});

const user_name = sessionStorage.getItem('username');
console.log(user_name)
// 엔터키를 눌러 메시지 전송
document.getElementById('messageInput').addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    console.log("dd")
    const message = event.target.value.trim();
    if (message) {
      socket.emit('sendMessage', {user_name:user_name, message:message});
      addMessageToChat('나', message);
      event.target.value = '';
    }
  }
});

// 메시지 수신 처리
socket.on('receiveMessage', (data) => {
  const {user_name, message} = data
  console.log(user_name, message)
  // if (username !== socket.id) { // 본인이 보낸 메시지를 서버에서 다시 받지 않도록 설정
  //   addMessageToChat(username, message);
  // }
  addMessageToChat(user_name, message);
});

// 파일 수신 처리
socket.on('receiveFile', (data) => {
  const {user_name,fileName, filePath} = data;
  if (user_name !== socket.id) { // 본인이 보낸 파일 정보를 서버에서 다시 받지 않도록 설정
    addFileLinkToChat(user_name, fileName, filePath);
  }
});

// 채팅에 메시지 추가 함수
function addMessageToChat(user_name, message) {
  console.log(user_name)
  
  const messages = document.getElementById('messages');
  const messageElement = document.createElement('div');
  messageElement.textContent = `${user_name}: ${message}`; // 여기
  messages.appendChild(messageElement);
  messages.scrollTop = messages.scrollHeight;
}

// 채팅에 파일 링크 추가 함수
function addFileLinkToChat(user_name, fileName, filePath) {
  console.log(fileName, filePath)
  const messages = document.getElementById('messages');
  const messageElement = document.createElement('div');
  const link = document.createElement('a');
  link.href = filePath;
  link.textContent = fileName;
  link.target = '_blank';
  link.download = fileName;
  messageElement.textContent = `${user_name} sent a file: `;
  messageElement.appendChild(link);
  messages.appendChild(messageElement);
  messages.scrollTop = messages.scrollHeight;
}
