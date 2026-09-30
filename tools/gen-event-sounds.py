#!/usr/bin/env python3
"""UI event sounds and call rings of the desktop / web client (owner-approved set, 2026-09-30).

One script renders every bundled cue in apps/desktop/resources/sounds/ (lib/sounds.ts
FILE_SOUNDS and RINGS). Our own synthesis: pure math → PCM, no third-party audio. The sound
design below (notes, timbres, timings, panning) was approved by ear — do not change it without
the owner; the output side (format, names, level) lives in save() and NAMES.

    python3 tools/gen-event-sounds.py                 → apps/desktop/resources/sounds/*.mp3
    python3 tools/gen-event-sounds.py <dir>           → <dir>/*.mp3 (candidates to listen to)

Needs python3 + numpy + scipy and ffmpeg (libmp3lame) on PATH.

Output: MP3, 44.1 kHz stereo (the cues are panned), 128 kbit/s CBR — plays in Electron and in
every browser of the web client (Safari has no Ogg/Opus before 18.4), each file ≤ ~25 KB.
Level: every file is scaled by one common gain (peak 0.85 of full scale, the approved render
used 0.6), so the relative levels stay as designed (ptt ticks and «stopped watching» are meant
to be quieter) and «new message» lands at the loudness of the old message.wav (≈ −11 LUFS).
Deterministic: fixed noise seed, ffmpeg -bitexact, no metadata — the same run writes the same
bytes. Played only through a plain <audio> element, never WebAudio (docs/02, echo rule 1).
"""
import numpy as np, subprocess, os, sys
from scipy.signal import butter, sosfilt
SR=44100; rng=np.random.default_rng(7)
def f(m): return 440*2**((m-69)/12)
def T(d): return np.arange(int(d*SR))/SR
def lp(x,fc,o=2): return sosfilt(butter(o,fc,'low',fs=SR,output='sos'),x)
def bp(x,a,b): return sosfilt(butter(2,[a,b],'band',fs=SR,output='sos'),x)
def ad(t,a,d):
    e=np.exp(-t*d); k=max(1,int(a*SR)); e[:k]*=np.linspace(0,1,k); return e
def warm(m,dur,d=8,a=.012,cut=1400):   # soft round tone: sine + faint 2nd, lowpassed
    t=T(dur); y=np.sin(2*np.pi*f(m)*t)+.18*np.sin(4*np.pi*f(m)*t)
    return lp(y,cut)*ad(t,a,d)
def bloop(m0,m1,dur=.16,g=1):          # water-drop style pitch sweep
    t=T(dur); fr=f(m0)*(f(m1)/f(m0))**np.minimum(t/(dur*.6),1)
    return np.sin(2*np.pi*np.cumsum(fr)/SR)*ad(t,.004,16)*g
def thump(m=43,dur=.25,g=1):           # soft low body
    t=T(dur); fr=f(m)*(1+1.5*np.exp(-t*30))
    return np.sin(2*np.pi*np.cumsum(fr)/SR)*ad(t,.003,14)*g
def whoosh(up,dur=.6,lo=300,hi=2500,g=1):  # filtered-noise sweep (smooth, no ring)
    n=rng.standard_normal(int(dur*SR)); t=T(dur); out=np.zeros_like(n)
    blocks=24; L=len(n)//blocks
    for i in range(blocks):
        p=i/(blocks-1); p=p if up else 1-p
        c=lo*(hi/lo)**p; seg=n[i*L:(i+1)*L+ L//2]
        s=bp(seg,c*.7,min(c*1.4,SR/2-100)); out[i*L:i*L+len(s)][:L]+=s[:L]
    e=np.sin(np.pi*np.minimum(t/dur,1))**2
    out=lp(out,3000)*e; return out/np.abs(out).max()*g
def pluck(m,dur=.3,g=1):               # dry wooden pluck, no ring
    t=T(dur); y=np.sin(2*np.pi*f(m)*t)+.3*np.sin(6*np.pi*f(m)*t)*np.exp(-t*60)
    return lp(y,2200)*ad(t,.002,22)*g
def pad(ms,dur,g=1):                   # soft chord swell
    t=T(dur); y=sum(np.sin(2*np.pi*f(m)*t)+.15*np.sin(4*np.pi*f(m)*t) for m in ms)
    return lp(y,900)*np.sin(np.pi*np.minimum(t/dur,1))**2*g
def bend_chord(ms,dur,start_semi,end_semi,bend_t,g=1,cut=1200,att=.03,rel=.25):
    # warm chord whose pitch glides (tape-start / tape-stop); no noise, no metallic partials
    t=T(dur); b=np.clip(t/bend_t,0,1); b=b*b*(3-2*b)
    semi=start_semi+(end_semi-start_semi)*b
    y=0
    for i,m in enumerate(ms):
        fr=f(m)*2**(semi/12)*(1+.0015*(i-1))   # slight detune = soft chorus
        ph=2*np.pi*np.cumsum(fr)/SR
        y=y+np.sin(ph)+.22*np.sin(2*ph)+.08*np.sin(3*ph)
    e=np.ones_like(t); ka=int(att*SR); kr=int(rel*SR)
    e[:ka]=np.linspace(0,1,ka); e[-kr:]*=np.linspace(1,0,kr)**2
    return lp(y,cut)*e*g
def tick(m,dur=.07,g=1): t=T(dur); return lp(np.sin(2*np.pi*f(m)*t),2500)*ad(t,.001,60)*g

def render(ev,total,room=.08):
    n=int(total*SR); L=np.zeros(n);R=np.zeros(n)
    for at,y,p in ev:
        i=int(at*SR); s=y[:max(0,n-i)].copy()
        # A partial cut off before it has decayed ends in a step (an audible click): 8 ms fade out.
        k=min(len(s),int(.008*SR)); s[len(s)-k:]*=0.5+0.5*np.cos(np.linspace(0,np.pi,k))
        L[i:i+len(s)]+=s*np.cos((p+1)*np.pi/4); R[i:i+len(s)]+=s*np.sin((p+1)*np.pi/4)
    for d,g in [(.023,room),(.041,room*.6)]:
        k=int(d*SR); L[k:]+=R[:n-k]*g; R[k:]+=L[:n-k]*g*.9
    o=np.stack([L,R],1); k=int(.03*SR); o[-k:]*=np.linspace(1,0,k)[:,None]; return o

# Design name → bundled file (lib/sounds.ts FILE_SOUNDS / RINGS import these names).
NAMES={
    'new_message':'message',
    'room_user_enter':'join',
    'room_user_leave':'leave',
    'self_disconnected_or_hangup_room':'disconnect',
    'room_self_reconnect_after_disconneted_or_reload_window':'reconnect',
    'screen_stream_starts':'stream-start',
    'screen_stream_ends':'stream-end',
    'screen_stream_someone_startwatch_your_stream':'watch-start',
    'screen_stream_someone_endwatch_your_stream':'watch-stop',
    'mute':'mute','unmute':'unmute','deafen':'deafen','undeafen':'undeafen',
    'ptt_on':'ptt-on','ptt_off':'ptt-off','mention':'mention','moved':'moved',
    'rec_start':'rec-start','rec_stop':'rec-stop',
    'call_incoming':'call-incoming','call_outgoing':'call-outgoing',
}
PEAK=.85   # common output peak (the approved render: .6) — see the header

def save(name,o):
    o=o/np.abs(o).max()*PEAK
    out=os.path.join(OUT,NAMES[name]+'.mp3')
    pcm=np.round(o*32767).astype('<i2').tobytes()
    subprocess.run(['ffmpeg','-y','-v','error','-f','s16le','-ar',str(SR),'-ac','2','-i','-',
                    '-map_metadata','-1','-fflags','+bitexact','-flags:a','+bitexact',
                    '-c:a','libmp3lame','-b:a','128k',out],input=pcm,check=True)
    print(f'{out}: {len(o)/SR:.2f} s, {os.path.getsize(out)} B')

HERE=os.path.dirname(os.path.abspath(__file__))
OUT=sys.argv[1] if len(sys.argv)>1 else os.path.join(HERE,'..','apps','desktop','resources','sounds')
os.makedirs(OUT,exist_ok=True)

# ---------------------------------------------------------------- room, chat, stream
# message: dry double "tok-tok" wooden pluck, mid register — nothing else sounds like it
save('new_message',render([(0,pluck(67,.25),-.15),(.13,pluck(72,.3),.15)],.45))
# enter: warm rounded rising sweep + soft landing note (one glide up, long-ish)
save('room_user_enter',render([(0,bloop(55,67,.35,.9),-.2),(.16,warm(67,.9,5,.02,1100),.1),(.16,warm(74,.9,6,.02,1100)*.5,.2)],1.15))
# leave: falling glide and a soft door-like thump
save('room_user_leave',render([(0,bloop(72,58,.3,.9),.2),(.22,thump(41,.5,.9),0)],1.0))
# hangup (self): low two-step descent, hollow, then thump — heavier than leave
save('self_disconnected_or_hangup_room',render([(0,warm(60,.4,7,.01,900),0),(.17,warm(53,.5,6,.01,800),0),(.34,thump(36,.7,1.2),0)],1.25))
# reconnect: three short equal ticks rising (a "trying → ok" pulse), then a warm chord
save('room_self_reconnect_after_disconneted_or_reload_window',render([(0,pluck(60,.15),-.3),(.14,pluck(64,.15),-.1),(.28,pluck(67,.15),.1),(.5,pad([60,64,67,72],.9,.8),0)],1.4))
# someone starts watching: a single soft upward "bloop", short
save('screen_stream_someone_startwatch_your_stream',render([(0,bloop(64,76,.18,1),.25),(.22,bloop(76,76,.12,.35),.25)],.5))
# someone stops watching: single soft downward "bloop", quieter and lower
save('screen_stream_someone_endwatch_your_stream',render([(0,bloop(70,55,.22,.75),-.25)],.45))
# stream starts: chord "powers up" from -7 semitones into D major, then a soft two-note pickup on top
save('screen_stream_starts',render([(0,bend_chord([50,57,62,66],1.05,-7,0,.32,1,1300,.02,.45),0),(.38,pluck(74,.3,.55),-.2),(.5,pluck(78,.35,.55),.2)],1.25))
# stream ends: same chord "powers down" (tape-stop), sinking an octave, then a dull low tap
save('screen_stream_ends',render([(0,bend_chord([50,57,62,66],.85,0,-12,.7,1,1100,.01,.35),0),(.72,thump(38,.4,.7),0)],1.15))

# ---------------------------------------------------------------- mic, moves, recording
# mute / unmute: one short soft "bloop", down = off, up = on (tiny, 0.2 s)
save('mute',render([(0,bloop(62,55,.14,.8),0)],.22,.03))
save('unmute',render([(0,bloop(58,65,.14,.8),0)],.22,.03))
# deafen / undeafen: muffled two-step (heavier lowpass = "ears covered"), longer than mute
save('deafen',render([(0,warm(62,.3,12,.008,700),0),(.09,warm(55,.35,10,.008,500),0)],.45,.03))
save('undeafen',render([(0,warm(55,.3,12,.008,700),0),(.09,warm(62,.35,10,.008,1200),0)],.45,.03))
# push-to-talk: barely-there dry ticks
save('ptt_on',render([(0,tick(79,.06),0)],.09,0))
save('ptt_off',render([(0,tick(72,.06,.8),0)],.09,0))
# mention: brighter than message — three quick plucks up, landing on a warm note ("hey, you")
save('mention',render([(0,pluck(72,.2,.9),-.2),(.08,pluck(76,.2,.9),0),(.16,warm(79,.5,7,.006,1600),.2)],.6))
# moved to another room: the same note hops left → right (spatial move), then settles
save('moved',render([(0,pluck(67,.2),-.8),(.12,pluck(67,.2),.8),(.24,warm(71,.45,8,.01,1200),0)],.65))
# recording start: two low ticks + a soft sustained tone with slow pulse ("tape rolling")
t=T(.55); rec=lp(np.sin(2*np.pi*f(64)*t),900)*np.sin(np.pi*np.minimum(t/.55,1))**2*(1+.25*np.sin(2*np.pi*7*t))
save('rec_start',render([(0,tick(60,.08),0),(.11,tick(60,.08),0),(.22,rec*.8,0)],.8,.04))
# recording stop: the tone, then a single low "tok" and a thump
save('rec_stop',render([(0,rec*.7,0),(.4,pluck(55,.25),0),(.45,thump(40,.3,.6),0)],.8,.04))

# ---------------------------------------------------------------- one-to-one calls (ADR-0034)
# incoming call: warm plucked phrase — melodic, not ringing (one cycle, looped by the app).
# No pad: the app repeats this file with a 1 s pause, so it must start at once and decay fully
# before the end (lib/sounds.ts RINGS).
ph=[(0,72),(.14,76),(.28,79),(.56,76),(.7,79),(.84,84)]
save('call_incoming',render([(a,pluck(m,.35,.9),(-.3 if i%2 else .3)) for i,(a,m) in enumerate(ph)],1.25))
# outgoing ring-back: calm low double pulse (what the caller hears while waiting; 3 s pause)
save('call_outgoing',render([(0,warm(64,.4,4,.03,900)+warm(67,.4,4,.03,900)*.6,0),(.5,warm(64,.4,4,.03,900)+warm(67,.4,4,.03,900)*.6,0)],1.0))
