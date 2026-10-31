/** Descriptive metadata only: never observation values or expected answers. */
export interface ColumnAnnotation {
  readonly label: string;
  readonly unit: string;
  readonly statisticsTableId?: string;
  readonly source?: string;
}
export interface ColumnAnnotationCatalogPort {
  forSource(sourceName: string): Promise<ReadonlyMap<string, ColumnAnnotation>>;
}
