<script lang="ts">
  /*@gvkit:if i18nParaglide*/
  import * as m from '@repo/i18n/messages'
  /*@gvkit:endif*/

  import { siteConfig } from '$lib/config/site'

  const year = new Date().getFullYear()
</script>

<footer class="text-muted-foreground py-6 text-center text-xs">
  © {year} {siteConfig.name}.
  <!--@gvkit:if i18nParaglide-->{m.footer_rights()}<!--@gvkit:else-->All rights reserved.<!--@gvkit:endif-->
</footer>
