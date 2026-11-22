import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Link } from 'react-router'
import { BackLink } from '../../components/ui'

// The campaign pages' top bar: back and the campaign's name, the steps in the middle, the actions at the end.
export function CampaignBar({ back = '/campaigns', title, steps, actions }: { back?: string; title: ReactNode; steps?: ReactNode; actions?: ReactNode }) {
  return <header className="studio-bar">
    <div className="studio-bar__start"><BackLink to={back} />{title}</div>
    <div className="studio-bar__steps">{steps}</div>
    <div className="studio-bar__end">{actions}</div>
  </header>
}

// Write, then Review: a campaign is put together first and checked and sent after, as in other mail tools.
export function CampaignSteps({ step, onReview, writeTo }: { step: 'write' | 'review'; onReview?: () => void; writeTo?: string }) {
  const write = <><span className="campaign-steps__mark" aria-hidden="true">{step === 'review' ? <Check size={12} /> : '1'}</span>Write</>
  const review = <><span className="campaign-steps__mark" aria-hidden="true">2</span>Review</>
  return <ol className="campaign-steps" aria-label="Steps">
    <li aria-current={step === 'write' ? 'step' : undefined}>{step === 'review' && writeTo ? <Link to={writeTo}>{write}</Link> : <span>{write}</span>}</li>
    <li aria-current={step === 'review' ? 'step' : undefined}>{step === 'write' ? <button type="button" disabled={!onReview} onClick={onReview}>{review}</button> : <span>{review}</span>}</li>
  </ol>
}
