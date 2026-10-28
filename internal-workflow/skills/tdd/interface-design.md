# Interface Design for Testability

Use these options only within an already-authorized interface change.
Preserve required side effects. Do not redesign production interfaces solely
to simplify tests.

Options that can make testing natural:

1. **Accept external dependencies where ownership calls for injection**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **Prefer explicit results for computations; preserve required side effects**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **Small surface area**
   - Fewer methods = fewer tests needed
   - Fewer params = simpler test setup
