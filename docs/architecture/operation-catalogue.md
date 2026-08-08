# Operation catalogue

> Generated from `apps/api/src/application/operations/registry.ts`. Run `npm run docs:check-operations` to detect drift.

| Operation | Provider | Effect | Permission | Tokens | Environments | Idempotency | Confirmation | REST | MCP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local.health | local | read | public | user, service | local, test, prod | not-applicable | not-applicable | GET /health | health_check |
| local.hello | local | read | catalogue.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/hello | hello_authenticated |
| reddit.thread | reddit | read | reddit.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/reddit/thread | reddit_get_thread |
| reddit.thread-overview | reddit | read | reddit.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/reddit/thread/overview | reddit_get_thread_overview |
| reddit.thread-comments | reddit | read | reddit.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/reddit/thread/comments | — |
| reddit.comment-tree | reddit | read | reddit.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/reddit/comment-tree | — |
| reddit.comments-batch | reddit | read | reddit.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/reddit/comments/batch | — |
| wlh.categories | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/wlh/categories/top | wlh_categories_top |
| wlh.category | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/wlh/categories/{categoryId} | — |
| wlh.find-category | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | — | wlh_find_category |
| wlh.category-children | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/wlh/categories/{categoryId}/children | wlh_category_children |
| wlh.search | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | POST /api/wlh/search | wlh_search |
| wlh.offer | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/wlh/offers/{adId} | wlh_get_offer |
| wlh.offer-images | wlh | read | wlh.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/wlh/offers/{adId}/images | — |
| bring.list-lists | bring | read | bring.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/bring/lists | bring_list_lists |
| bring.get-items | bring | read | bring.read | user, service | local, test, prod | not-applicable | not-applicable | GET /api/bring/lists/{listUuid}/items | bring_get_items |
| bring.add-items | bring | write | bring.write | user, service | local, prod | required | not-applicable | POST /api/bring/lists/{listUuid}/items | bring_add_items |
| bring.prepare-complete-items | bring | destructive | bring.complete | user | local, prod | required | required | POST /api/bring/lists/{listUuid}/mutations/prepare | — |
| bring.prepare-remove-items | bring | destructive | bring.remove | user | local, prod | required | required | POST /api/bring/lists/{listUuid}/mutations/prepare | — |
| bring.apply-complete-items | bring | destructive | bring.complete | user | local, prod | required | required | POST /api/bring/lists/{listUuid}/mutations/apply | — |
| bring.apply-remove-items | bring | destructive | bring.remove | user | local, prod | required | required | POST /api/bring/lists/{listUuid}/mutations/apply | — |
