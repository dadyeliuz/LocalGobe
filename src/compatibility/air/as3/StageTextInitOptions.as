package flash.text
{
   /**
    * Clean-room LocalGobe AIR compatibility shim for flash.text.StageTextInitOptions.
    */
   public class StageTextInitOptions
   {
      public var multiline:Boolean;

      public function StageTextInitOptions(multiline:Boolean = false)
      {
         super();
         this.multiline = multiline;
      }
   }
}
