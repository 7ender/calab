import { APP_URL } from '@/lib/site';
import { Button, Container, ThemedImage } from './ui';
import { MacWindow } from './window';

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="hero-bg overflow-hidden pt-16 pb-20 sm:pt-24 sm:pb-28">
      <Container className="text-center">
        <img src="/icon-512.png" alt="" width={96} height={96} className="mx-auto size-20 sm:size-24" />
        <h1 id="hero-title" className="mt-6 text-[48px] leading-[56px] font-bold tracking-tight sm:text-[64px] sm:leading-[72px]">
          Calab
        </h1>
        <p className="mx-auto mt-4 max-w-[640px] text-[20px] leading-7 text-pretty text-fg-2 sm:text-[24px] sm:leading-8">
          Голосовые комнаты, чат и стрим экрана для команды — на&nbsp;вашем сервере
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="#download" className="w-full max-w-[280px] sm:w-auto">
            Скачать
          </Button>
          <Button href={APP_URL} variant="secondary" className="w-full max-w-[280px] sm:w-auto">
            Открыть в браузере
          </Button>
        </div>
        <p className="mt-4 text-[14px] leading-5 text-fg-2">macOS, Windows, Linux и браузер</p>
      </Container>
      <Container className="mt-12 sm:mt-16">
        <div className="mx-auto max-w-[1080px]">
          <MacWindow>
            <ThemedImage
              name="hero"
              width={1440}
              height={800}
              priority
              alt="Окно Calab: список комнат с голосовой комнатой «Переговорка», чат канала «общий» и участники в сети"
            />
          </MacWindow>
        </div>
      </Container>
    </section>
  );
}
