import LandingPageWellnessEditor from './LandingPageWellnessEditor';

// Generic pages use the same responsive campaign composition and palette
// controls as wellness pages, but they enter through a generic root marker.
// Keeping this wrapper explicit prevents the builder from falling back to the
// legacy manual block canvas or accidentally mounting a travel editor.
export default function LandingPageGenericEditor(props) {
  return <LandingPageWellnessEditor {...props} mode="generic" />;
}
