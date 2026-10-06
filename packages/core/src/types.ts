export type RawSalary = {
  min?: number;
  max?: number;
  currency: string;
  period: "year" | "month" | "hour";
};

export type RawPosting = {
  /** Adapter name: "greenhouse" | "lever" | "ashby" | "web3career" | "remotive" | "remoteok" | "himalayas" | "weworkremotely" | "hn". */
  source: string;
  /** Stable id within the source. */
  externalId: string;
  /** Public posting page. */
  url: string;
  applyUrl?: string;
  title: string;
  company: string;
  companyDomain?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  locationText?: string;
  /** Only when the source states it explicitly. */
  remote?: boolean;
  /** Free text as shown by the source. */
  salaryText?: string;
  /** Only when the source provides structured numbers. */
  salary?: RawSalary;
  /** ISO 8601, UTC. */
  postedAt?: string;
  tags?: string[];
};

export interface SourceAdapter {
  /** Same as RawPosting.source. */
  name: string;
  /** Poll no more often than this. */
  minIntervalMinutes: number;
  fetch(since: Date): Promise<RawPosting[]>;
}
