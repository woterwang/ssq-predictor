Component({
  properties: { loading: Boolean, error: String, empty: Boolean, emptyText: String, lastUpdated: String },
  methods: { retry() { if (!this.data.loading) this.triggerEvent('retry'); } },
});