// 浏览器要求用户点过页面后才能出声，所以第一次点页面时就把声音准备好
let audio: AudioContext | null = null
export function unlockAudio() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
  } catch {
    // 不支持就算了，还有系统通知和弹窗
  }
}

export function chime() {
  unlockAudio()
  if (!audio) return
  const t = audio.currentTime
  ;[880, 1320, 880, 1320].forEach((f, i) => {
    const o = audio!.createOscillator()
    const g = audio!.createGain()
    o.type = 'sine'
    o.frequency.value = f
    const start = t + i * 0.22
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(0.3, start + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2)
    o.connect(g).connect(audio!.destination)
    o.start(start)
    o.stop(start + 0.21)
  })
}

/** 加入排队时调用（要在点击里调用，浏览器才会弹出通知授权） */
export function prepareQueueAlerts() {
  unlockAudio()
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission().catch(() => {})
  }
}

