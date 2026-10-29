export type SummaryStats = {
  results_found: number;
  resources_scanned: number;
  relevant_knowledge_hubs: string;
  search_time_seconds: number;
};

export type StructuredSummary = {
  executive_summary: string;
  insights_for_policymakers: string;
  insights_for_businesses: string;
  insights_for_financial_institutions: string;
  insights_for_interested_people: string;
};

export type SummaryDocument = {
  citation_index: number;
  title: string;
  source?: string;
  relevance_score: number;
  description: string;
  url?: string;
  thumbnail_url?: string;
  publication_date?: string;
  topics?: string[];
};

export type SummaryResponse = {
  query: string;
  stats: SummaryStats;
  summary: StructuredSummary;
  documents: SummaryDocument[];
};
