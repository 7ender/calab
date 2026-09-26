import { Downloads } from '@/components/downloads';
import { Faq } from '@/components/faq';
import { Features } from '@/components/features';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how';
import { Pricing } from '@/components/pricing';

export default function Home() {
  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <Features />
        <HowItWorks />
        <Downloads />
        <Pricing />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
